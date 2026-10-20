// 版本 8：token 计量拆出缓存命中 / 未命中。
//
// DeepSeek 在 usage 里直接给 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
// OpenAI 给 prompt_tokens_details.cached_tokens（只有命中数）。两列都可空：
//   NULL = 这次端点没报缓存字段，不代表「全未命中」
//   >=0  = 上游明确给出的 token 数
//
// 老数据留 NULL；读的时候不要拿 0 当命中率的分母。
export default function up(db, h) {
  h.addColumn('session_metrics', 'cache_hit_tokens', 'INTEGER');
  h.addColumn('session_metrics', 'cache_miss_tokens', 'INTEGER');
}
