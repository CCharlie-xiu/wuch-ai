// ─────────────────────────────────────────────────────────────────────────────
// 行分流器：模型的回答里界面语句和写给人看的文字混在一起，按行分开。
//
//   `@` 开头                                      → 界面
//   `名字 = 调用(` / `[` / `{` / 引号 / 反引号      → 界面，读到右侧开头就能确定
//   `名字 = 数字 / 变量名 / null / true / false`    → 界面，但要等整行读完才敢定
//   其余的行                                       → 文字回答，不进编译
//
// 关键在「等到能确定为止」。散文里常有 `t = ln10 / ln2` 这种算式，行首一眼像赋值语句，
// 但右侧不是 DSL 认的值（DSL 只认四种：组件调用、数组、字面量、变量名）。原来的判定
// 一见到 `名字 =` 就定成界面，这类行会被送进编译器 → 左侧重编 + 报诊断 + 顶掉画布。
// 现在行首读到能判断为止再放行，判断完的行逐字直通。
//
// 围栏两种：包界面的（```openui，画界面时不写语言的也算）两边都不要；
// 别的代码块整块原样算文字，里面的 `x = 1` 不能当界面。
//
// allowUi=false：这一轮不该写界面（比如第一段只是接住用户的话）时，界面语句一律按
// 文字放行 —— 编译器一个字节都收不到，画布自然不会被半截散文顶掉。
// ─────────────────────────────────────────────────────────────────────────────

/** 包界面的围栏语言标记 */
export const UI_FENCE = /^(openui|openui-lang|oui|ui)$/i;

/** 行首是 `名字 =` */
const UI_HEAD = /^[A-Za-z_$][\w$]*\s*=/;
/** 右侧以调用 / 数组 / 对象 / 字符串开头：读到这里就能确定是界面 */
const UI_CALL = /^[A-Za-z_$][\w$]*\s*=\s*(?:[A-Za-z_$][\w$.]*\s*\(|[\[{("'`])/;
/** 右侧是数字 / 变量名 / 关键字：跟散文长得一样，只有整行正好是 `名字 = 值` 才算界面 */
const UI_PLAIN =
  /^[A-Za-z_$][\w$]*\s*=\s*(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z_$][\w$]*|null|true|false)\s*$/;
/** 行首只到一个名字：可能长成 `名字 = …`，也可能只是散文里的一个词 */
const BARE_NAME = /^[A-Za-z_$][\w$]*\s*$/;
/** 行首缓冲上限：这么长还没定性，就按文字放行，别一直憋着 */
const MAX_HEAD = 200;

export class LineRouter {
  constructor({ allowUi = true } = {}) {
    this.buf = ''; // 行首还没判断的几个字
    this.kind = null; // 当前这一行：null 还没判断 / 'ui' / 'text' / 'fence' / 'code'
    this.depth = 0;
    this.quote = null;
    this.escaped = false;
    this.uiSeen = false;
    this.inCode = false; // 在文字代码块里
    this.uiFences = false; // 不写语言的围栏算界面包装（画界面时）
    this.allowUi = allowUi; // 这一轮允不允许把界面语句送进编译器
  }

  push(chunk) {
    const out = { ui: '', text: '' };
    for (const ch of chunk) this.step(ch, out);
    return out;
  }

  flush() {
    const out = { ui: '', text: '' };
    if (this.kind === null && this.buf) this.decide(out, true);
    return out;
  }

  step(ch, out) {
    if (this.kind === null) {
      this.buf += ch;
      this.decide(out, ch === '\n');
      return;
    }
    this.emit(ch, out);
  }

  /** 行首这一行算什么 —— 读到行尾（lineDone）或者已经能确定，才会走到这里 */
  decide(out, lineDone) {
    const lead = this.buf.trimStart();
    if (!lineDone) {
      if (!lead) return;
      // 还可能长成 ``` 或 `名字 =`：再等几个字；围栏行要读到行尾才知道语言
      if (/^`{1,2}$/.test(lead)) return;
      if (/^```/.test(lead) && !this.inCode) return;
      if (this.pending(lead)) return;
    }
    if (this.inCode) {
      // 代码块里逐行原样给文字，读到收尾围栏为止
      if (/^```/.test(lead)) this.inCode = false;
      this.kind = 'code';
      const pending = this.buf;
      this.buf = '';
      for (const c of pending) this.emit(c, out);
      return;
    }
    if (!lead) {
      // 空行两边都留：文字要段落间隔，界面原文保持模型写的样子
      if (this.buf.includes('\n')) {
        out.text += '\n';
        if (this.uiSeen) out.ui += '\n';
      }
      this.buf = '';
      return;
    }
    if (/^```/.test(lead)) {
      const lang = lead.slice(3).trim().split(/\s/)[0];
      // allowUi 关的时候，围栏包着的界面也算文字代码块 —— 整块原样进右栏
      if (!this.allowUi || (lang ? !UI_FENCE.test(lang) : !this.uiFences)) {
        this.inCode = true;
        this.kind = 'code';
        const pending = lead;
        this.buf = '';
        for (const c of pending) this.emit(c, out);
        return;
      }
    }
    this.kind = /^```/.test(lead) ? 'fence' : this.looksLikeUi(lead, lineDone) ? 'ui' : 'text';
    if (this.kind === 'ui') this.uiSeen = true;
    const pending = this.kind === 'text' ? lead : this.buf;
    this.buf = '';
    for (const c of pending) this.emit(c, out);
  }

  /** 这一行还可能长成界面语句吗 —— 是就再等几个字，别急着定性 */
  pending(lead) {
    if (this.inCode || !this.allowUi || lead.length >= MAX_HEAD) return false;
    if (BARE_NAME.test(lead)) return true;
    return UI_HEAD.test(lead) && !UI_CALL.test(lead);
  }

  looksLikeUi(lead, lineDone) {
    if (!this.allowUi) return false;
    if (lead[0] === '@') return true;
    return UI_CALL.test(lead) || (lineDone && UI_PLAIN.test(lead));
  }

  emit(ch, out) {
    if (this.kind === 'ui') {
      out.ui += ch;
      this.track(ch);
    } else if (this.kind === 'text' || this.kind === 'code') out.text += ch;
    if (ch !== '\n') return;
    // 语句还没闭合：下一行接着算界面
    this.kind = this.kind === 'ui' && (this.depth > 0 || this.quote) ? 'ui' : null;
  }

  track(ch) {
    if (this.quote) {
      if (this.escaped) this.escaped = false;
      else if (ch === '\\') this.escaped = true;
      else if (ch === this.quote) this.quote = null;
      return;
    }
    if (ch === '"' || ch === "'") this.quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') this.depth++;
    else if ((ch === ')' || ch === ']' || ch === '}') && this.depth > 0) this.depth--;
  }
}
