import {GrammarDeclaration, RuleDeclaration, TokenGroupDeclaration,
        Expression, Identifier, LiteralExpression, NamedExpression, SequenceExpression,
        ChoiceExpression, RepeatExpression, SetExpression, AnyExpression, MarkedExpression,
        exprsEq, exprEq} from "./node"
import {Term, TermSet, Precedence, Rule} from "./grammar"
import {Edge, State, MAX_CHAR} from "./token"
import {Input} from "./parse"
import {buildAutomaton, State as LRState, Shift, Reduce} from "./automaton"
import {Parser, ParseState, REDUCE_DEPTH_SIZE, noToken, Tokenizer} from "lezer"

const none: ReadonlyArray<any> = []

const verbose = (typeof process != "undefined" && process.env.LOG) || ""

class PrecTerm {
  constructor(readonly term: Term, readonly prec: Precedence[]) {}

  get terminal() { return this.term.terminal }
  get name() { return this.term.name }

  static from(term: Term$, prec: Precedence): Term$ {
    if (term instanceof PrecTerm) return new PrecTerm(term.term, [prec].concat(term.prec))
    else return new PrecTerm(term, [prec])
  }

  static onFirst(terms: Term$[], prec: Precedence): Term$[] {
    return terms.length ? [PrecTerm.from(terms[0], prec)].concat(terms.slice(1)) : terms
  }
}

type Term$ = Term | PrecTerm

class Context {
  constructor(readonly b: Builder,
              readonly rule: RuleDeclaration) {}

  newName(deco?: string, repeats?: Term) {
    return this.b.newName(this.rule.id.name + (deco ? "-" + deco : ""), deco ? true : null, repeats)
  }

  newNameFor(expr: Expression, add: string, repeats?: Term): Term {
    let name = findNameFor(expr)
    return name ? this.b.newName(name + add, true, repeats) : this.newName(add, repeats)
  }

  defineRule(name: Term, choices: Term$[][]) {
    for (let choice of choices) {
      let precedences = none as ReadonlyArray<Precedence>[]
      let terms = choice.map((term, i) => {
        if (!(term instanceof PrecTerm)) return term
        if (precedences == none) precedences = []
        for (let j = 0; j < i; j++) precedences.push(none)
        precedences[i] = term.prec
        return term.term
      })
      this.b.rules.push(new Rule(name, terms, precedences))
    }
    return [name]
  }

  resolve(expr: NamedExpression): Term[] {
    if (expr.namespace) {
      let ns = this.b.namespaces[expr.namespace.name]
      if (!ns)
        this.raise(`Reference to undefined namespace '${expr.namespace.name}'`, expr.start)
      return ns.resolve(expr, this)
    } else if (expr.id.name == "specialize") {
      return this.resolveSpecialization(expr)
    } else {
      for (let built of this.b.built) if (built.matches(expr)) return [built.term]

      for (let tokens of this.b.tokenGroups) {
        let found = tokens.getToken(expr, this)
        if (found) return [found]
      }

      let known = this.b.ast.rules.find(r => r.id.name == expr.id.name)
      if (!known)
        return this.raise(`Reference to undefined rule '${expr.id.name}'`, expr.start)
      if (known.params.length != expr.args.length)
        this.raise(`Wrong number or arguments for '${expr.id.name}'`, expr.start)
      return this.buildRule(known, expr.args)
    }
  }

  normalizeTopExpr(expr: Expression, self: Term): Term$[][] {
    if (expr instanceof RepeatExpression && expr.kind == "?") {
      return [[], ...this.normalizeTopExpr(expr.expr, self)]
    } else if (expr instanceof ChoiceExpression) {
      return expr.exprs.map(e => this.normalizeExpr(e))
    } else if (expr instanceof MarkedExpression) {
      return this.normalizeTopExpr(expr.expr, self).map(terms => PrecTerm.onFirst(terms, this.b.getPrecedence(expr)))
    } else {
      return [this.normalizeExpr(expr)]
    }
  }

  // For tree-balancing reasons, repeat expressions X* have to be
  // normalized to something like
  //
  //     Outer -> ε | Inner
  //     Inner -> X | Inner Inner
  //
  // (With the ε part gone for + expressions.)
  //
  // Returns the terms that make up the outer rule.
  normalizeRepeat(expr: RepeatExpression) {
    let known = this.b.built.find(b => b.matchesRepeat(expr))
    if (known) return [known.term]

    let inner = this.newNameFor(expr.expr, expr.kind)
    inner.repeated = true
    let outer = this.newNameFor(expr.expr, expr.kind + "-wrap", inner)
    this.b.built.push(new BuiltRule(expr.kind, [expr.expr], outer))

    let top = this.normalizeTopExpr(expr.expr, inner)
    top.push([inner, PrecTerm.from(inner, new Precedence(false, Precedence.REPEAT, "left", null))])
    this.defineRule(inner, top)
    this.defineRule(outer, expr.kind == "+" ? [[inner]] : [[], [inner]])
    return [outer]
  }

  normalizeExpr(expr: Expression): Term$[] {
    if (expr instanceof RepeatExpression && expr.kind == "?") {
      let name = this.newNameFor(expr.expr, "?")
      return this.defineRule(name, [[] as Term$[]].concat(this.normalizeTopExpr(expr.expr, name)))
    } else if (expr instanceof RepeatExpression) {
      return this.normalizeRepeat(expr)
    } else if (expr instanceof ChoiceExpression) {
      return this.defineRule(this.newName(), expr.exprs.map(e => this.normalizeExpr(e)))
    } else if (expr instanceof SequenceExpression) {
      return expr.exprs.reduce((a, e) => a.concat(this.normalizeExpr(e)), [] as Term$[])
    } else if (expr instanceof LiteralExpression) {
      return expr.value ? [this.b.tokenGroups[0].getLiteral(expr)] : []
    } else if (expr instanceof NamedExpression) {
      return this.resolve(expr)
    } else if (expr instanceof MarkedExpression) {
      return PrecTerm.onFirst(this.normalizeExpr(expr.expr), this.b.getPrecedence(expr))
    } else {
      return this.raise("This type of expression may not occur in non-token rules", expr.start)
    }
  }

  raise(message: string, pos: number = -1): never {
    return this.b.input.raise(message, pos)
  }

  buildRule(rule: RuleDeclaration, args: ReadonlyArray<Expression>): Term[] {
    let cx = new Context(this.b, rule)
    let expr = this.b.substituteArgs(rule.expr, args, rule.params)
    this.b.used[rule.id.name] = true
    let name = this.b.newName(rule.id.name + (args.length ? "<" + args.join(",") + ">" : ""),
                              rule.tag ? rule.tag.name : isTag(rule.id.name) || true)
    this.b.built.push(new BuiltRule(rule.id.name, args, name))
    return cx.defineRule(name, cx.normalizeTopExpr(expr, name))
  }

  resolveSpecialization(expr: NamedExpression) {
    if (expr.args.length < 2 || expr.args.length > 3) this.raise(`'specialize' takes two or three arguments`, expr.start)
    if (!(expr.args[1] instanceof LiteralExpression))
      this.raise(`The second argument to 'specialize' must be a literal`, expr.args[1].start)
    let tag = null
    if (expr.args.length == 3) {
      let tagArg = expr.args[2]
      if (!(tagArg instanceof NamedExpression) || tagArg.args.length)
        return this.raise(`The third argument to 'specialize' must be a name (without arguments)`)
      tag = tagArg.id.name
    }
    let terminal = this.normalizeExpr(expr.args[0])
    if (terminal.length != 1 || !terminal[0].terminal)
      this.raise(`The first argument to 'specialize' must resolve to a token`, expr.args[0].start)
    let term = terminal[0].name, value = (expr.args[1] as LiteralExpression).value
    let table = this.b.specialized[term] || (this.b.specialized[term] = Object.create(null))
    let known = table[value], token: Term
    if (known == null) {
      token = this.b.makeTerminal(term + "-" + JSON.stringify(value), tag, this.b.tokens[term])
      table[value] = token.id
    } else {
      token = this.b.terms.terminals.find(t => t.id == known)!
    }
    return [token]
  }
}

function findNameFor(expr: Expression): string | null {
  if (expr instanceof NamedExpression) return `${expr.namespace ? expr.namespace.name + "." : ""}${expr.id.name}`
  if (expr instanceof RepeatExpression || expr instanceof MarkedExpression) return findNameFor(expr.expr)
  if (expr instanceof ChoiceExpression || expr instanceof SequenceExpression) return findNameFor(expr.exprs[0])
  if (expr instanceof LiteralExpression) return JSON.stringify(expr.value)
  return null
}

function isTag(name: string) {
  let ch0 = name[0]
  return ch0.toUpperCase() == ch0 && ch0 != "_" ? name : null
}

class BuiltRule {
  constructor(readonly id: string,
              readonly args: ReadonlyArray<Expression>,
              readonly term: Term) {}

  matches(expr: NamedExpression) {
    return this.id == expr.id.name && exprsEq(expr.args, this.args)
  }

  matchesRepeat(expr: RepeatExpression) {
    return this.id == expr.kind && exprEq(expr.expr, this.args[0])
  }
}

class Builder {
  ast: GrammarDeclaration
  input: Input
  terms = new TermSet
  tokenGroups: TokenGroup[] = []
  specialized: {[name: string]: {[value: string]: number}} = Object.create(null)
  rules: Rule[] = []
  built: BuiltRule[] = []
  ruleNames: {[name: string]: boolean} = Object.create(null)
  namespaces: {[name: string]: Namespace} = Object.create(null)
  tokens: {[name: string]: TokenGroup} = Object.create(null)
  used: {[name: string]: boolean} = Object.create(null)

  constructor(text: string, fileName: string | null = null) {
    this.input = new Input(text, fileName)
    this.ast = this.input.parse()

    if (this.ast.tokens) this.gatherTokenGroups(this.ast.tokens)
    else this.tokenGroups.push(new TokenGroup(this, none, null))

    this.defineNamespace("tag", new TagNamespace)

    for (let rule of this.ast.rules) {
      this.unique(rule.id)
      if (this.namespaces[rule.id.name])
        this.input.raise(`Rule name '${rule.id.name}' conflicts with a defined namespace`, rule.id.start)
      if (rule.id.name == "program") {
        if (rule.params.length) this.input.raise(`'program' rules should not take parameters`, rule.id.start)
        new Context(this, rule).buildRule(rule, [])
      }
    }

    if (!this.rules.length)
      this.input.raise(`Missing 'program' rule declaration`)
    for (let rule of this.ast.rules) if (!this.used[rule.id.name])
      // FIXME should probably be a warning
      this.input.raise(`Unused rule '${rule.id.name}'`, rule.start)
    for (let rule of this.rules) if (rule.parts.length >= 64)
      this.input.raise(`Overlong rule (${rule.parts.length} > 63) in grammar`)
    for (let tokens of this.tokenGroups) tokens.checkUnused()
  }

  unique(id: Identifier) {
    if (this.ruleNames[id.name])
      this.input.raise(`Duplicate definition of rule '${id.name}'`, id.start)
    if (id.name == "specialize") this.input.raise("The name 'specialize' is reserved for a built-in operator", id.start)
    this.ruleNames[id.name] = true
  }

  defineNamespace(name: string, value: Namespace, pos: number = 0) {
    if (this.namespaces[name]) this.input.raise(`Duplicate definition of namespace '${name}'`, pos)
    this.namespaces[name] = value
  }

  newName(base: string, tag: string | null | true = null, repeats?: Term): Term {
    for (let i = tag ? 0 : 1;; i++) {
      let name = i ? `${base}-${i}` : base
      if (!this.terms.nonTerminals.some(t => t.name == name))
        return this.terms.makeNonTerminal(name, tag === true ? null : tag, repeats)
    }
  }

  getParserData() {
    let rules = simplifyRules(this.rules)
    if (/\bgrammar\b/.test(verbose)) console.log(rules.join("\n"))
    let table = buildAutomaton(rules, this.terms)
    if (/\blr\b/.test(verbose)) console.log(table.join("\n"))
    let tokenizers: string[] = []
    let skipped: (string | null)[] = []
    for (let group of this.tokenGroups) {
      skipped.push(group.skipState ? group.skipState.compile().toSource() :
                   group.parent ? skipped[this.tokenGroups.indexOf(group.parent)] : null)
      let startState = group.startState.compile()
      tokenizers.push(startState.toSource())
      if (startState.accepting)
        this.input.raise(`Grammar contains zero-length tokens (in '${startState.accepting.name}')`,
                         group.rules.find(r => r.id.name == startState.accepting!.name)!.start)
      if (group.skipState && /\bskip\b/.test(verbose)) console.log(group.skipState.compile().toString())
      if (/\btokens\b/.test(verbose)) console.log(startState.toString())
    }
    let specialized = [], specializations = []
    for (let name in this.specialized) {
      specialized.push(this.terms.terminals.find(t => t.name == name)!.id)
      specializations.push(this.specialized[name])
    }
    let states = table.map(s => this.stateData(s, skipped, tokenizers))
    return {rules, states, specialized, specializations}
  }

  getParser() {
    let {states, specialized, specializations} = this.getParserData()
    let evaluated: {[source: string]: Tokenizer} = Object.create(null)
    function getFunc(source: string | null): Tokenizer {
      return source == null ? noToken : evaluated[source] || (evaluated[source] = (1,eval)("(" + source + ")"))
    }
    let stateObjs = states.map((s, i) => {
      let {actions, goto, recover, defaultReduce, forcedReduce, skip, tokenizers} = s
      return new ParseState(i, actions, goto, recover, defaultReduce, forcedReduce, getFunc(skip), tokenizers.map(getFunc))
    })
    return new Parser(stateObjs, this.terms.tags, this.terms.repeatInfo, specialized, specializations, this.terms.names)
  }

  getParserString({includeNames = false, moduleStyle = "CommonJS"}: GenOptions) {
    let {states, specialized, specializations} = this.getParserData()
    let counts: {[key: string]: number} = Object.create(null)
    function count(value: any) { let key = "" + value; counts[key] = (counts[key] || 0) + 1 }

    let tokenizerNames: {[key: string]: string} = Object.create(null), tokenizerID = 0, tokenizerText = "", sawNoToken = false
    function tokenizerName(tok: string | null) {
      if (!tok) { sawNoToken = true; return "noToken" }
      let name = tokenizerNames[tok]
      if (!name) {
        tokenizerNames[tok] = name = "t" + tokenizerID++
        tokenizerText += tok.replace(/\bfunction\b/, `function ${name}`) + "\n"
      }
      return name
    }

    function tokenizersToCode(toks: (string | null)[]) {
      return "[" + toks.map(tokenizerName).join(",") + "]"
    }
    function numbersToCode(nums: number[]) {
      return "[" + nums.join(",") + "]"
    }

    for (let state of states) {
      count(numbersToCode(state.actions))
      count(numbersToCode(state.goto))
      count(numbersToCode(state.recover))
      count(tokenizersToCode(state.tokenizers))
    }

    let generated: {[key: string]: string} = Object.create(null)
    let varID = 0, varText = ""
    function reference(code: string) {
      let count = counts[code]
      if (count == 1) return code
      let name = generated[code]
      if (!name) {
        name = generated[code] = "v" + (varID++)
        varText += `let ${name} = ${code};\n`
      }
      return name
    }

    let stateText = []
    for (let state of states) {
      stateText.push(`s(${state.defaultReduce || reference(numbersToCode(state.actions))
                      }, ${reference(numbersToCode(state.goto))}, ${state.forcedReduce}, ${
                      tokenizerName(state.skip)}, ${reference(tokenizersToCode(state.tokenizers))}${
                      state.recover.length ? ", " + reference(numbersToCode(state.recover)) : ""})`)
    }

    return "// This file was generated by the parser generator (FIXME)\n" +
      (moduleStyle == "es6" ? `import {s, Parser${sawNoToken ? ", noToken" : ""}} from "lezer"\n`
       : `const {s, Parser${sawNoToken ? ", noToken" : ""}} = require("lezer")\n`) +
      tokenizerText +
      varText +
      "s.id = 0\n" +
      (moduleStyle == "es6" ? `export default` : `module.exports = `) +
      `new Parser([\n  ${stateText.join(",\n  ")}\n],\n${JSON.stringify(this.terms.tags)},\n${
JSON.stringify(this.terms.repeatInfo)},\n${JSON.stringify(specialized)},\n${JSON.stringify(specializations)
}${includeNames ? `,\n${JSON.stringify(this.terms.names)}` : ""})`
  }

  gatherTokenGroups(decl: TokenGroupDeclaration, parent: TokenGroup | null = null) {
    let group = new TokenGroup(this, decl.rules, parent)
    this.tokenGroups.push(group)
    for (let subGroup of decl.groups) this.gatherTokenGroups(subGroup, group)
  }

  makeTerminal(name: string, tag: string | null, group: TokenGroup) {
    for (let i = 0;; i++) {
      let cur = i ? `${name}-${i}` : name
      if (this.terms.terminals.some(t => t.name == cur)) continue
      this.tokens[cur] = group
      return this.terms.makeTerminal(cur, tag)
    }
  }

  stateData(state: LRState, skipped: (null | string)[], tokenizers: string[]) {
    let actions = [], goto = [], recover = [], forcedReduce = 0, defaultReduce = 0
    if (state.actions.length) {
      let first = state.actions[0] as Reduce
      if (state.actions.every(a => a instanceof Reduce && a.rule == first.rule))
        defaultReduce = reduce(first.rule)
    }
    for (let action of state.actions) {
      let value = action instanceof Shift ? -action.target.id : reduce(action.rule)
      if (value != defaultReduce) actions.push(action.term.id, value)
    }
    // FIXME maybe also have a default goto? see how often duplicates occur
    for (let action of state.goto)
      goto.push(action.term.id, action.target.id)
    for (let action of state.recover)
      recover.push(action.term.id, action.target.id)
    let positions = state.set.filter(p => p.pos > 0)
    if (positions.length) {
      let defaultPos = positions.reduce((a, b) => a.pos - b.pos || b.rule.parts.length - a.rule.parts.length < 0 ? b : a)
      forcedReduce = (defaultPos.rule.name.id << REDUCE_DEPTH_SIZE) | defaultPos.pos
    }
    let {skip, tokenizers: tok} = this.tokensForState(state, skipped, tokenizers)
    return {actions, goto, recover, defaultReduce, forcedReduce, skip, tokenizers: tok}
  }

  tokensForState(state: LRState, skipped: (null | string)[], tokenizers: string[]) {
    let found: (string | null)[] = [], skip = null
    for (let action of state.actions) {
      let group = this.tokens[action.term.name]
      let index = this.tokenGroups.indexOf(group)
      let curSkip = skipped[index < 0 ? 0 : index]
      if (skip != curSkip) {
        if (skip != null)
          this.input.raise(`Inconsistent skip rules for state ${state.set.filter(p => p.pos > 0).join() || "start"}`)
        skip = curSkip
      }
      if (index < 0) continue
      let tokenizer = tokenizers[index]
      if (!found.includes(tokenizer)) found.push(tokenizer)
    }
    if (found.length == 0) found.push(null)
    return {skip, tokenizers: found}
  }

  substituteArgs(expr: Expression, args: ReadonlyArray<Expression>, params: ReadonlyArray<Identifier>) {
    if (args.length == 0) return expr
    return expr.walk(expr => {
      let found
      if (expr instanceof NamedExpression && !expr.namespace &&
          (found = params.findIndex(p => p.name == expr.id.name)) > -1) {
        let arg = args[found]
        if (expr.args.length) {
          if (arg instanceof NamedExpression && !arg.args.length)
            return new NamedExpression(expr.start, arg.namespace, arg.id, expr.args)
          this.input.raise(`Passing arguments to a parameter that already has arguments`, expr.start)
        }
        return arg
      }
      return expr
    })
  }

  getPrecedence(expr: MarkedExpression): Precedence {
    if (!expr.namespace) {
      let precs = this.ast.precedences!
      let pos = precs ? precs.names.findIndex(id => id.name == expr.id.name) : -1
      if (pos < 0) this.input.raise(`Reference to unknown precedence: '${expr.id.name}'`, expr.start)
      return new Precedence(false, precs.names.length - pos, precs.assoc[pos], null)
    }
    if (expr.namespace.name != "ambig")
      this.input.raise(`Unrecognized conflict marker '!${expr.namespace.name}.${expr.id.name}'`, expr.start)
    return new Precedence(true, 0, null, expr.id.name)
  }
}

function reduce(rule: Rule) {
  return (rule.name.id << REDUCE_DEPTH_SIZE) | rule.parts.length
}

interface Namespace {
  resolve(expr: NamedExpression, cx: Context): Term[]
}

class TagNamespace implements Namespace {
  resolve(expr: NamedExpression, cx: Context): Term[] {
    if (expr.args.length != 1)
      cx.raise(`Tag wrappers take a single argument`, expr.start)
    let tag = expr.id.name
    let name = cx.b.newName(`tag.${tag}`, tag)
    return cx.defineRule(name, cx.normalizeTopExpr(expr.args[0], name))
  }
}

class TokenArg {
  constructor(readonly name: string, readonly expr: Expression, readonly scope: ReadonlyArray<TokenArg>) {}
}

class TokenGroup {
  startState: State = new State
  skipState: State | null = null
  built: BuiltRule[] = []
  used: {[name: string]: boolean} = Object.create(null)
  building: string[] = [] // Used for recursion check

  constructor(readonly b: Builder,
              readonly rules: ReadonlyArray<RuleDeclaration>,
              readonly parent: TokenGroup | null) {
    for (let rule of rules) if (rule.id.name != "skip") this.b.unique(rule.id)
    let skip = rules.find(r => r.id.name == "skip")
    if (skip) {
      this.used.skip = true
      if (skip.params.length) return this.raise("Skip rules should not take parameters", skip.params[0].start)
      this.skipState = new State
      let nameless = new State(b.terms.eof)
      for (let choice of skip.expr instanceof ChoiceExpression ? skip.expr.exprs : [skip.expr]) {
        let tag = null
        if (choice instanceof NamedExpression) {
          let rule = this.rules.find(r => r.id.name == (choice as NamedExpression).id.name)
          if (rule) tag = rule.tag ? rule.tag.name : isTag(rule.id.name)
        }
        let dest = tag ? new State(this.b.makeTerminal(tag, tag, this)) : nameless
        dest.connect(this.build(choice, this.skipState, none))
      }
    }
  }

  getToken(expr: NamedExpression, cx: Context) {
    for (let built of this.built) if (built.matches(expr)) return built.term
    let name = expr.id.name
    let rule = this.rules.find(r => r.id.name == name)
    if (!rule) return null
    let term = this.b.makeTerminal(expr.toString(), rule.tag ? rule.tag.name : isTag(name), this)
    let end = new State(term)
    end.connect(this.buildRule(rule, expr, this.startState))
    this.built.push(new BuiltRule(name, expr.args, term))
    return term
  }

  getLiteral(expr: LiteralExpression) {
    let id = JSON.stringify(expr.value)
    for (let built of this.built) if (built.id == id) return built.term
    let term = this.b.makeTerminal(id, null, this)
    let end = new State(term)
    end.connect(this.build(expr, this.startState, none))
    this.built.push(new BuiltRule(id, none, term))
    return term
  }

  defines(term: Term): boolean {
    return this.built.some(b => b.term == term)
  }

  raise(msg: string, pos: number = -1): never {
    return this.b.input.raise(msg, pos)
  }

  buildRule(rule: RuleDeclaration, expr: NamedExpression, from: State, args: ReadonlyArray<TokenArg> = none): Edge[] {
    let name = expr.id.name
    if (rule.params.length != expr.args.length)
      this.raise(`Incorrect number of arguments for token '${name}'`, expr.start)
    this.used[name] = true
    if (this.building.includes(name))
      this.raise(`Recursive token rules: ${this.building.slice(this.building.lastIndexOf(name)).join(" -> ")}`, expr.start)
    this.building.push(name)
    let result = this.build(this.b.substituteArgs(rule.expr, expr.args, rule.params), from,
                            expr.args.map((e, i) => new TokenArg(rule!.params[i].name, e, args)))
    this.building.pop()
    return result
  }

  build(expr: Expression, from: State, args: ReadonlyArray<TokenArg>): Edge[] {
    if (expr instanceof NamedExpression) {
      if (expr.namespace) {
        if (expr.namespace.name == "std") return this.buildStd(expr, from)
        this.b.input.raise(`Unknown namespace '${expr.namespace.name}'`, expr.start)
      }
      let name = expr.id.name, arg = args.find(a => a.name == name)
      if (arg) return this.build(arg.expr, from, arg.scope)
      let rule: RuleDeclaration | undefined = undefined
      for (let scope: TokenGroup | null = this; scope && !rule; scope = scope.parent)
        rule = scope.rules.find(r => r.id.name == name)
      if (!rule) return this.raise(`Reference to rule '${expr.id.name}', which isn't found in this token group`, expr.start)
      return this.buildRule(rule, expr, from, args)
    } else if (expr instanceof ChoiceExpression) {
      return expr.exprs.reduce((out, expr) => out.concat(this.build(expr, from, args)), [] as Edge[])
    } else if (expr instanceof SequenceExpression) {
      for (let i = 0;; i++) {
        let next = this.build(expr.exprs[i], from, args)
        if (i == expr.exprs.length - 1) return next
        from = new State
        from.connect(next)
      }
    } else if (expr instanceof RepeatExpression) {
      if (expr.kind == "*") {
        let loop = new State
        from.nullEdge(loop)
        loop.connect(this.build(expr.expr, loop, args))
        return [loop.nullEdge()]
      } else if (expr.kind == "+") {
        let loop = new State
        loop.connect(this.build(expr.expr, from, args))
        loop.connect(this.build(expr.expr, loop, args))
        return [loop.nullEdge()]
      } else { // expr.kind == "?"
        return [from.nullEdge()].concat(this.build(expr.expr, from, args))
      }
    } else if (expr instanceof SetExpression) {
      let edges: Edge[] = []
      for (let [a, b] of expr.inverted ? invertRanges(expr.ranges) : expr.ranges)
        edges = edges.concat(rangeEdges(from, a, b))
      return edges
    } else if (expr instanceof LiteralExpression) {
      if (expr.value == "") return [from.nullEdge()]
      for (let i = 0;;) {
        let ch = expr.value.charCodeAt(i++)
        if (i < expr.value.length) {
          let next = new State
          from.edge(ch, ch + 1, next)
          from = next
        } else {
          return [from.edge(ch, ch + 1)]
        }
      }
    } else if (expr instanceof AnyExpression) {
      return [from.edge(0, MAX_CHAR + 1)]
    } else {
      return this.raise(`Unrecognized expression type in token`, (expr as any).start)
    }
  }

  buildStd(expr: NamedExpression, from: State) {
    if (expr.args.length) this.raise(`'std.${expr.id.name}' does not take arguments`, expr.args[0].start)
    if (!STD_RANGES.hasOwnProperty(expr.id.name)) this.raise(`There is no builtin rule 'std.${expr.id.name}'`, expr.start)
    return STD_RANGES[expr.id.name].map(([a, b]) => from.edge(a, b)) 
  }

  checkUnused() {
    for (let rule of this.rules) if (!this.used[rule.id.name])
      // FIXME should probably be a warning
      this.raise(`Unused token rule '${rule.id.name}'`, rule.start)
  }
}

function invertRanges(ranges: [number, number][]) {
  let pos = 0, result: [number, number][] = []
  for (let [a, b] of ranges) {
    if (a > pos) result.push([pos, a])
    pos = b
  }
  if (pos <= MAX_CHAR) result.push([pos, MAX_CHAR + 1])
  return result
}

const ASTRAL = 0x10000, GAP_START = 0xd800, GAP_END = 0xe000

// Create intermediate states for astral characters in a range, if
// necessary, since the tokenizer acts on UTF16 characters
function rangeEdges(from: State, low: number, hi: number): Edge[] {
  let edges: Edge[] = []
  if (low < ASTRAL) {
    if (low < GAP_START) edges.push(from.edge(low, Math.min(hi, GAP_START)))
    if (hi > GAP_END) edges.push(from.edge(Math.max(low, GAP_END), Math.min(hi, MAX_CHAR + 1)))
    low = ASTRAL
  }
  if (hi < ASTRAL) return edges
  let lowStr = String.fromCodePoint(low), hiStr = String.fromCodePoint(hi - 1)
  let lowA = lowStr.charCodeAt(0), lowB = lowStr.charCodeAt(1)
  let hiA = hiStr.charCodeAt(0), hiB = hiStr.charCodeAt(1)
  if (lowA == hiA) { // Share the first char code
    let mid = new State
    from.edge(lowA, lowA + 1, mid)
    edges.push(mid.edge(lowB, hiB + 1))
  } else {
    let top = new State
    from.edge(lowA, lowA + 1, top)
    edges.push(top.edge(lowB, MAX_CHAR + 1))
    if (lowA + 1 < hiA - 1) {
      let mid = new State
      from.edge(lowA + 1, hiA, mid)
      edges.push(mid.edge(0, MAX_CHAR + 1))
    }
    let bot = new State
    from.edge(hiA, hiA + 1, bot)
    edges.push(bot.edge(0, hiB + 1))
  }
  return edges
}

const STD_RANGES: {[name: string]: [number, number][]} = {
  asciiLetter: [[65, 91], [97, 123]],
  asciiLowercase: [[97, 123]],
  asciiUppercase: [[65, 91]],
  digit: [[48, 58]],
  whitespace: [[9, 14], [32, 33], [133, 134], [160, 161], [5760, 5761], [8192, 8203],
               [8232, 8234], [8239, 8240], [8287, 8288], [12288, 12289]]
}

// FIXME maybe add a pass that, if there's a tagless token whole only
// use is in a tagged single-term rule, move the tag to the token and
// collapse the rule.

function inlineRules(rules: ReadonlyArray<Rule>): ReadonlyArray<Rule> {
  for (;;) {
    let inlinable: {[name: string]: Rule} = Object.create(null), found
    for (let i = 0; i < rules.length; i++) {
      let rule = rules[i]
      if (!rule.name.interesting && !rule.parts.includes(rule.name) && rule.parts.length < 3 &&
          !rule.parts.some(p => !!inlinable[p.name]) &&
          !rules.some((r, j) => j != i && r.name == rule.name))
        found = inlinable[rule.name.name] = rule
    }
    if (!found) return rules
    let newRules = []
    for (let rule of rules) {
      if (inlinable[rule.name.name]) continue
      if (!rule.parts.some(p => !!inlinable[p.name])) {
        newRules.push(rule)
        continue
      }
      let prec = [], parts = []
      for (let i = 0; i < rule.parts.length; i++) {
        let replace = inlinable[rule.parts[i].name]
        if (!replace) {
          if (i < rule.precedence.length) {
            while (prec.length < parts.length) prec.push(none)
            prec.push(rule.precedence[i])
          }
          parts.push(rule.parts[i])
        } else {
          for (let j = 0; j < replace.parts.length; j++) {
            let partPrec = j ? replace.precAt(j) : Precedence.join(rule.precAt(i), replace.precAt(j))
            if (partPrec.length) {
              while (prec.length < parts.length) prec.push(none)
              prec.push(partPrec)
            }
            parts.push(replace.parts[j])
          }
        }
      }
      newRules.push(new Rule(rule.name, parts, prec))
    }
    rules = newRules
  }
}

function mergeRules(rules: ReadonlyArray<Rule>): ReadonlyArray<Rule> {
  let merged: {[name: string]: Term} = Object.create(null), found
  for (let i = 0; i < rules.length;) {
    let groupStart = i
    let name = rules[i++].name
    while (i < rules.length && rules[i].name == name) i++
    let size = i - groupStart
    if (name.interesting) continue
    for (let j = i; j < rules.length;) {
      let otherStart = j, otherName = rules[j++].name
      while (j < rules.length && rules[j].name == otherName) j++
      if (j - otherStart != size || otherName.interesting) continue
      let match = true
      for (let k = 0; k < size && match; k++) {
        let a = rules[groupStart + k], b = rules[otherStart + k]
        if (a.cmpNoName(b) != 0) match = false
      }
      if (match) found = merged[name.name] = otherName
    }
  }
  if (!found) return rules
  let newRules = []
  for (let rule of rules) if (!merged[rule.name.name]) {
    newRules.push(rule.parts.every(p => !merged[p.name]) ? rule :
                  new Rule(rule.name, rule.parts.map(p => merged[p.name] || p), rule.precedence))
  }
  return newRules
}

function simplifyRules(rules: ReadonlyArray<Rule>): ReadonlyArray<Rule> {
  return mergeRules(inlineRules(rules))
}

export function buildParser(text: string, fileName: string | null = null): Parser {
  return new Builder(text, fileName).getParser()
}

export type GenOptions = {includeNames?: boolean, moduleStyle?: string}

export function buildParserFile(text: string, fileName: string | null = null, options: GenOptions = {}): string {
  return new Builder(text, fileName).getParserString(options)
}