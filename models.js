/*
 * models.js — single source of truth for Claude model IDs and metadata.
 *
 * Loaded as a plain <script> in the browser AND `require()`d by both
 * Netlify Functions (generate.js, generate-stream.mjs). One file means
 * adding/renaming a model is a single edit, not the four-place sync that
 * burned an hour in the past.
 *
 * Keep this file tiny and dependency-free. If a field needs computation,
 * compute it in the consumer.
 *
 * Schema per model:
 *   id                    canonical Anthropic model ID — DO NOT GUESS.
 *                         Verify against Anthropic's current model
 *                         reference before adding.
 *   label                 short label shown in pill-style locations.
 *   uiNote                long form for the dropdown ("fastest, ~$X").
 *   inputCostPerMtok      USD per 1M input tokens. Used for batch cost preview.
 *   outputCostPerMtok     USD per 1M output tokens. Same.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.keys(api).forEach(function (k) { root[k] = api[k]; });
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const MODELS = [
    {
      id: 'claude-haiku-4-5-20251001',
      label: 'Haiku 4.5',
      uiNote: 'fastest, ~$0.007 per draft',
      inputCostPerMtok: 1.00,
      outputCostPerMtok: 5.00
    },
    {
      id: 'claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      uiNote: 'balanced, ~$0.022 per draft',
      inputCostPerMtok: 3.00,
      outputCostPerMtok: 15.00
    },
    {
      id: 'claude-opus-4-7',
      label: 'Opus 4.7',
      uiNote: 'highest quality, ~$0.035 per draft',
      inputCostPerMtok: 5.00,
      outputCostPerMtok: 25.00
    }
  ];

  const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

  function modelIds() {
    return MODELS.map(function (m) { return m.id; });
  }

  function findModel(id) {
    for (let i = 0; i < MODELS.length; i++) {
      if (MODELS[i].id === id) return MODELS[i];
    }
    return null;
  }

  function modelLabel(id) {
    const m = findModel(id);
    return m ? m.label : id;
  }

  return {
    MODELS: MODELS,
    DEFAULT_MODEL_ID: DEFAULT_MODEL_ID,
    modelIds: modelIds,
    findModel: findModel,
    modelLabel: modelLabel
  };
});
