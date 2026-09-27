// ─────────────────────────────────────────────────────────────────────────────
// Tool: calculator
// Evaluates simple arithmetic expressions using safe string parsing.
// Supported: +, -, *, /, (, ), integers and decimals.
// Does NOT use eval() — parses the expression manually.
// ─────────────────────────────────────────────────────────────────────────────

export interface CalcResult {
  expression: string;
  result:     number | null;
  error?:     string;
}

// Tokeniser ───────────────────────────────────────────────────────────────────

type Token =
  | { kind: "number"; value: number }
  | { kind: "op";     value: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" };

function tokenise(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === " ") { i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if ("+-*/".includes(ch)) {
      tokens.push({ kind: "op", value: ch as "+" | "-" | "*" | "/" });
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i++]; }
      tokens.push({ kind: "number", value: parseFloat(num) });
      continue;
    }
    throw new Error(`Unexpected character: '${ch}'`);
  }
  return tokens;
}

// Recursive-descent parser (handles precedence correctly) ────────────────────

function parse(tokens: Token[]): number {
  let pos = 0;

  function peek(): Token | undefined { return tokens[pos]; }
  function consume(): Token { return tokens[pos++]; }

  function parseExpr(): number    { return parseAddSub(); }

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (peek()?.kind === "op" && (peek() as { value: string }).value.match(/[+-]/)) {
      const op = (consume() as { value: string }).value;
      const right = parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv(): number {
    let left = parseUnary();
    while (peek()?.kind === "op" && (peek() as { value: string }).value.match(/[*/]/)) {
      const op = (consume() as { value: string }).value;
      const right = parseUnary();
      if (op === "/" && right === 0) throw new Error("Division by zero");
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseUnary(): number {
    const t = peek();
    if (t?.kind === "op" && t.value === "-") { consume(); return -parseAtom(); }
    return parseAtom();
  }

  function parseAtom(): number {
    const t = peek();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.kind === "number") { consume(); return t.value; }
    if (t.kind === "lparen") {
      consume();
      const val = parseExpr();
      if (peek()?.kind !== "rparen") throw new Error("Missing closing parenthesis");
      consume();
      return val;
    }
    throw new Error(`Unexpected token: ${JSON.stringify(t)}`);
  }

  return parseExpr();
}

// Public API ──────────────────────────────────────────────────────────────────

export function calculate(expression: string): CalcResult {
  try {
    const tokens = tokenise(expression);
    const result = parse(tokens);
    return { expression, result };
  } catch (err) {
    return {
      expression,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
