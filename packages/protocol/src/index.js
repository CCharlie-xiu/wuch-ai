// ─────────────────────────────────────────────────────────────────────────────
// UI 操作协议
//
// 运行时本身不画任何东西。它把「新树和旧树的差异」编码成一串操作，
// 交给宿主页面去应用到自己的组件树上。
//
//   CREATE #8  box     SET border = true, padding = 3, gap = 2   PLACE under root at 2
//   CREATE #9  slider  SET min = 1, max = 50, value = 8, onChange = fn#1
//
// 函数永远不离开 worker：滑块的处理器只以一个标识符（fn#1）上线。
// 在线路上，操作被编码成一串二进制整数，字符串单独放一张表。
// ─────────────────────────────────────────────────────────────────────────────

export const OP = { CREATE: 1, SET: 2, PLACE: 3, REMOVE: 4, TEXT: 5 };
export const KIND = { VALUE: 0, FN: 1 };

// ── varint ─────────────────────────────────────────────────────────────────
function writeVarint(bytes, n) {
  n = n >>> 0;
  for (;;) {
    const b = n & 0x7f;
    n >>>= 7;
    if (n === 0) {
      bytes.push(b);
      return;
    }
    bytes.push(b | 0x80);
  }
}
function readVarint(bytes, st) {
  let out = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[st.i++];
    out |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return out >>> 0;
    shift += 7;
  }
}

class Tables {
  constructor() {
    this.strings = [];
    this.stringIndex = new Map();
    this.values = [];
    this.valueIndex = new Map();
  }
  str(s) {
    if (this.stringIndex.has(s)) return this.stringIndex.get(s);
    const i = this.strings.length;
    this.strings.push(s);
    this.stringIndex.set(s, i);
    return i;
  }
  val(v) {
    const key = typeof v === 'string' ? 's' + v : JSON.stringify(v ?? null);
    if (this.valueIndex.has(key)) return this.valueIndex.get(key);
    const i = this.values.length;
    this.values.push(JSON.stringify(v ?? null));
    this.valueIndex.set(key, i);
    return i;
  }
}

/** ops → 二进制 + 字符串表 */
export function encodeOps(ops) {
  const t = new Tables();
  const bytes = [];
  for (const op of ops) {
    if (op.op === OP.CREATE) {
      writeVarint(bytes, OP.CREATE);
      writeVarint(bytes, op.id);
      writeVarint(bytes, t.str(op.type));
      writeVarint(bytes, op.parent ?? 0);
      writeVarint(bytes, op.index ?? 0);
      writeVarint(bytes, op.props.length);
      for (const [name, kind, value] of op.props) {
        writeVarint(bytes, t.str(name));
        writeVarint(bytes, kind);
        writeVarint(bytes, kind === KIND.FN ? t.str(value) : t.val(value));
      }
    } else if (op.op === OP.SET) {
      writeVarint(bytes, OP.SET);
      writeVarint(bytes, op.id);
      writeVarint(bytes, op.props.length);
      for (const [name, kind, value] of op.props) {
        writeVarint(bytes, t.str(name));
        writeVarint(bytes, kind);
        writeVarint(bytes, kind === KIND.FN ? t.str(value) : t.val(value));
      }
    } else if (op.op === OP.PLACE) {
      writeVarint(bytes, OP.PLACE);
      writeVarint(bytes, op.id);
      writeVarint(bytes, op.parent ?? 0);
      writeVarint(bytes, op.index ?? 0);
    } else if (op.op === OP.REMOVE) {
      writeVarint(bytes, OP.REMOVE);
      writeVarint(bytes, op.id);
    } else if (op.op === OP.TEXT) {
      writeVarint(bytes, OP.TEXT);
      writeVarint(bytes, op.id);
      writeVarint(bytes, t.str(op.value ?? ''));
    }
  }
  return { bytes: Uint8Array.from(bytes), strings: t.strings, values: t.values };
}

/** 解码，用于检视器 */
export function decodeOps(payload) {
  const { bytes, strings, values } = payload;
  const st = { i: 0 };
  const out = [];
  const val = (kind, idx) => (kind === KIND.FN ? { fn: strings[idx] } : JSON.parse(values[idx]));
  while (st.i < bytes.length) {
    const op = readVarint(bytes, st);
    if (op === OP.CREATE) {
      const id = readVarint(bytes, st);
      const type = strings[readVarint(bytes, st)];
      const parent = readVarint(bytes, st);
      const index = readVarint(bytes, st);
      const n = readVarint(bytes, st);
      const props = [];
      for (let k = 0; k < n; k++) {
        const name = strings[readVarint(bytes, st)];
        const kind = readVarint(bytes, st);
        props.push([name, val(kind, readVarint(bytes, st))]);
      }
      out.push({ op: 'CREATE', id, type, parent, index, props });
    } else if (op === OP.SET) {
      const id = readVarint(bytes, st);
      const n = readVarint(bytes, st);
      const props = [];
      for (let k = 0; k < n; k++) {
        const name = strings[readVarint(bytes, st)];
        const kind = readVarint(bytes, st);
        props.push([name, val(kind, readVarint(bytes, st))]);
      }
      out.push({ op: 'SET', id, props });
    } else if (op === OP.PLACE) {
      out.push({ op: 'PLACE', id: readVarint(bytes, st), parent: readVarint(bytes, st), index: readVarint(bytes, st) });
    } else if (op === OP.REMOVE) {
      out.push({ op: 'REMOVE', id: readVarint(bytes, st) });
    } else if (op === OP.TEXT) {
      out.push({ op: 'TEXT', id: readVarint(bytes, st), value: strings[readVarint(bytes, st)] });
    } else break;
  }
  return out;
}

/** 一行一条的人类可读形式，对应博客里那段操作清单 */
export function formatOps(decoded) {
  const pad = (s, n) => String(s).padEnd(n, ' ');
  return decoded.map((o) => {
    if (o.op === 'CREATE') {
      const sets = o.props.map(([k, v]) => `${k} = ${fmt(v)}`).join(', ');
      return `CREATE #${pad(o.id, 4)} ${pad(o.type, 16)} ${pad(sets ? 'SET ' + sets : '', 52)} PLACE under ${o.parent === 0 ? 'root' : '#' + o.parent} at ${o.index}`;
    }
    if (o.op === 'SET') return `SET    #${pad(o.id, 4)} ${o.props.map(([k, v]) => `${k} = ${fmt(v)}`).join(', ')}`;
    if (o.op === 'PLACE') return `PLACE  #${pad(o.id, 4)} under ${o.parent === 0 ? 'root' : '#' + o.parent} at ${o.index}`;
    if (o.op === 'REMOVE') return `REMOVE #${pad(o.id, 4)}`;
    return `TEXT   #${pad(o.id, 4)} ${JSON.stringify(o.value)}`;
  });
}

const fmt = (v) => (v && typeof v === 'object' && 'fn' in v ? v.fn : JSON.stringify(v));

/**
 * 操作里的 props 是 [[名, 值]] 的键值对数组（线上就是这么编的）。
 * 渲染器要的是对象 —— 转换只做一次，放在这里，避免两边对不上。
 */
export function propsToObject(pairs) {
  const out = {};
  if (!pairs) return out;
  for (const [name, value] of pairs) out[name] = value;
  return out;
}

export function hexDump(bytes, limit = 256) {
  const rows = [];
  for (let i = 0; i < Math.min(bytes.length, limit); i += 16) {
    const slice = Array.from(bytes.slice(i, i + 16));
    const hex = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${i.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > limit) rows.push(`… 共 ${bytes.length} 字节`);
  return rows.join('\n');
}
