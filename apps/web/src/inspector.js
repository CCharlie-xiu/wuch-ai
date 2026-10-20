// ─────────────────────────────────────────────────────────────────────────────
// 检视器：把每一层的中间产物摊开。聊天页和演示页共用同一份实现。
//
// 期望的 DOM（两页一致）：
//   [data-tab="dil|code|json|ops|diag|patch"]        页签按钮
//   .panel[data-panel="…"]                           面板容器
//   #panel-dil / #panel-code / #code-meta / #panel-json
//   #panel-ops / #ops-hex / #panel-diag / #panel-patch / #patch-log
//   #hud                                             一行状态
// ─────────────────────────────────────────────────────────────────────────────

import { formatOps, hexDump } from '@openui-lab/protocol';
import { replayIn } from './motion.js';

export function createInspector({ session, root = document }) {
  const one = (sel) => root.querySelector(sel);
  const setText = (sel, text) => {
    const n = one(sel);
    if (n) n.textContent = text;
  };

  /**
   * 切页签。animate: false 给程序化切换用（启动、右侧总结点引用定位）——
   * 那些场景紧接着还有滚动定位，等一段动画会显得迟钝。
   */
  function switchTab(name, { animate = true } = {}) {
    for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
    for (const p of root.querySelectorAll('.panel[data-panel]')) {
      const on = p.dataset.panel === name;
      p.classList.toggle('active', on);
      if (on && animate) replayIn(p, 'panel-in');
    }
  }

  function bindTabs() {
    for (const b of root.querySelectorAll('[data-tab]')) {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    }
  }

  function hud() {
    const s = session.snapshot();
    const r = s.rendererStats;
    return [
      `文本 ${s.raw.length} 字符`,
      `更新 ${s.serverStats.updates}`,
      `重编译 ${s.serverStats.recompiles}`,
      `DOM ${s.nodeCount}`,
      `操作 ${r.ops}（create ${r.creates} / set ${r.sets}）`,
      s.running ? '流式中' : '已收敛',
    ].join('  ·  ');
  }

  function refresh() {
    const s = session.snapshot();
    setText('#panel-dil', s.raw || '（还没有内容）');
    setText('#panel-code', s.code || '（还没编译出程序）');
    setText(
      '#code-meta',
      s.code ? `程序 ${s.code.length} 字节 · 常量表 ${JSON.stringify(s.constants).length} 字节 · 元素 ${s.stats?.elements ?? '?'} 个` : ''
    );
    setText('#panel-json', JSON.stringify({ constants: s.constants, appData: s.appData }, null, 2));

    const ops = s.opsLog || [];
    const tail = ops.slice(-90);
    setText('#panel-ops', ops.length ? `本轮共 ${ops.length} 个操作，显示最后 ${tail.length} 个：\n\n${formatOps(tail).join('\n')}` : '（还没有操作）');
    setText(
      '#ops-hex',
      s.lastPayload
        ? `${s.lastPayload.bytes.length} 字节 · 字符串表 ${s.lastPayload.strings.length} 项 · 值表 ${s.lastPayload.values.length} 项\n\n${hexDump(s.lastPayload.bytes, 320)}`
        : '（还没有字节流）'
    );

    setText('#panel-diag', diagText(s));
    setText('#panel-patch', patchText(s));
    const log = (s.patchLog || []).slice(-40);
    setText(
      '#patch-log',
      log
        .map(
          (p) =>
            `${String(Math.round(p.at - s.serverStats.startedAt)).padStart(5)}ms  ${p.kind.padEnd(9)} ${String(p.size).padStart(6)}B  ${JSON.stringify(
              p.payload.v[0]
            ).slice(0, 96)}`
        )
        .join('\n')
    );

    const h = one('#hud');
    if (h) h.textContent = hud();
  }

  function diagText(s) {
    const parts = [];
    if (s.lockInfo) {
      parts.push('【沙箱 lockdown】');
      parts.push(`已移除 ${s.lockInfo.removed.length} 个全局能力：`);
      parts.push('  ' + s.lockInfo.removed.join(', '));
      parts.push(`已冻结：${s.lockInfo.frozen.join(', ')}`);
      if (s.lockInfo.failed.length) parts.push(`没能处理：${s.lockInfo.failed.join(', ')}`);
      parts.push('');
    }
    const line = (x) => `  ${x.pos ? `${x.pos.line}:${x.pos.column}`.padEnd(7) : '       '}${x.code}  ${x.message}`;
    parts.push('【编译期诊断（按目录校验，出问题的部分已摘掉）】');
    if (s.diagnostics && s.diagnostics.length) {
      for (const x of s.diagnostics) parts.push(line(x));
    } else parts.push('  （无）');
    parts.push('');
    parts.push('【流式恢复诊断（切在没写完的语句上）】');
    if (s.recovery && s.recovery.length) {
      for (const x of s.recovery) parts.push(line(x));
    } else parts.push('  （无）');
    if (s.notes && s.notes.length) {
      parts.push('');
      parts.push('【流式进度】');
      for (const n of s.notes) parts.push('  · ' + n);
    }
    if (s.workerErrors && s.workerErrors.length) {
      parts.push('');
      parts.push('【运行时错误（worker 内）】');
      for (const e of s.workerErrors) parts.push(`  ${e.kind || ''} ${e.message || JSON.stringify(e)}`);
    }
    if (s.renderErrors && s.renderErrors.length) {
      parts.push('');
      parts.push('【渲染器错误】');
      for (const e of s.renderErrors.slice(0, 8)) parts.push('  ' + JSON.stringify(e));
    }
    return parts.join('\n');
  }

  function patchText(s) {
    const st = s.serverStats;
    const intervals = st.intervals.slice(-40).sort((a, b) => a - b);
    const median = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0;
    const resentPct = st.patchBytes ? Math.round((st.resentBytes / st.patchBytes) * 100) : 0;
    const dur = st.endedAt ? (st.endedAt - st.startedAt) / 1000 : 0;
    return [
      `原始文本        ${st.chars} 字符`,
      `更新次数        ${st.updates} 次${dur ? ` · 历时 ${dur.toFixed(1)}s` : ''}`,
      `重编译次数      ${st.recompiles} 次（全量重编译，非增量）`,
      `patch 总量      ${(st.patchBytes / 1024).toFixed(1)} KB`,
      `重发代码占比    ${resentPct}%（程序是一整个嵌套表达式，只能整段替换）`,
      `更新中位间隔    ${median.toFixed(0)} ms`,
      '',
      '【三类更新】',
      `  结构变了        ${st.kinds.structure} 次   追加文字 + 整段编译产物`,
      `  只有文字长了    ${st.kinds.text} 次   追加文字 + 一个新常量，程序没变`,
      `  还拼不出组件    ${st.kinds.pending} 次   只追加文字，界面不动`,
      `  服务端数据      ${st.kinds.data || 0} 次   图片 / 实体结果补进来`,
    ].join('\n');
  }

  bindTabs();

  return { switchTab, refresh, hud };
}
