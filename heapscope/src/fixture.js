'use strict';
// Synthetic V8-format heapsnapshots for offline self-test.
// Models a classic RN leak: listeners + FiberNodes held by a global emitter.

const NODE_TYPES = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'];
const EDGE_TYPES = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'];
const NODE_FIELDS = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'];
const EDGE_FIELDS = ['type', 'name_or_index', 'to_node'];
const LOCATION_FIELDS = ['object_index', 'script_id', 'line', 'column'];

function build(objects) {
  const strings = [];
  const si = new Map();
  const S = s => {
    const k = String(s);
    if (si.has(k)) return si.get(k);
    const i = strings.length; strings.push(k); si.set(k, i); return i;
  };
  S('');
  const idToIndex = new Map(objects.map((o, i) => [o.id, i]));
  const nodes = [], edges = [], locations = [];
  for (const o of objects) {
    nodes.push(NODE_TYPES.indexOf(o.type), S(o.name), o.id, o.size, (o.edges || []).length, 0, 0);
  }
  objects.forEach((o, idx) => {
    if (o.loc) locations.push(idx * NODE_FIELDS.length, 0, o.loc.line, o.loc.column);
    for (const e of o.edges || []) {
      const to = idToIndex.get(e.to);
      if (to == null) continue;
      const nameOrIndex = e.type === 'element' ? Number(e.name) || 0 : S(e.name);
      edges.push(EDGE_TYPES.indexOf(e.type), nameOrIndex, to * NODE_FIELDS.length);
    }
  });
  return {
    snapshot: {
      meta: {
        node_fields: NODE_FIELDS, node_types: [NODE_TYPES, 'string', 'number', 'number', 'number', 'number', 'number'],
        edge_fields: EDGE_FIELDS, edge_types: [EDGE_TYPES, 'string_or_number', 'node'],
        trace_function_info_fields: ['function_id', 'name', 'script_name', 'script_id', 'line', 'column'],
        trace_node_fields: ['id', 'function_info_index', 'count', 'size', 'children'],
        location_fields: LOCATION_FIELDS,
        sample_fields: ['timestamp_us', 'last_assigned_id', 'size'],
      },
      node_count: objects.length, edge_count: edges.length / EDGE_FIELDS.length,
    },
    nodes, edges, strings, locations, trace_function_infos: [], trace_tree: {}, samples: [],
  };
}

function makeFixture() {
  let nextId = 1;
  const id = () => nextId++;
  const rootId = id(), globalId = id(), emitterId = id(), listenersId = id();
  const live = { listeners: [], fibers: [], temps: [] };

  const addListener = (tag) => {
    const lid = id(), fid = id();
    const closure = {
      id: lid, type: 'closure', name: `onStoreDetailScroll@${40 + tag}:7`, size: 96,
      loc: { line: 40 + tag, column: 7 },
      edges: [{ type: 'property', name: 'payload', to: fid }],
    };
    const fiber = { id: fid, type: 'object', name: 'FiberNode', size: 512, edges: [] };
    live.listeners.push(closure); live.fibers.push(fiber);
    return lid;
  };
  const addTemp = (tag) => {
    live.temps.push({ id: id(), type: 'object', name: 'TempCacheEntry', size: 2048, edges: [] });
  };

  // A: baseline - 2 listeners
  addListener(0); addListener(1);
  const objectsA = assemble(rootId, globalId, emitterId, listenersId, live);
  const snapA = build(objectsA);

  // B: +3 leaked listeners, +3 short-lived temporaries
  for (let i = 0; i < 3; i++) addListener(2 + i);
  for (let i = 0; i < 3; i++) addTemp(i);
  const snapB = build(assemble(rootId, globalId, emitterId, listenersId, live));

  // C: temporaries released, +3 more leaked listeners
  live.temps = [];
  for (let i = 0; i < 3; i++) addListener(5 + i);
  const snapC = build(assemble(rootId, globalId, emitterId, listenersId, live));

  return [
    { label: 'A · baseline', data: snapA },
    { label: 'B · round 1', data: snapB },
    { label: 'C · round 2', data: snapC },
  ];
}

function assemble(rootId, globalId, emitterId, listenersId, live) {
  const objects = [
    { id: rootId, type: 'synthetic', name: 'GC roots', size: 0, edges: [
      { type: 'property', name: 'global', to: globalId },
      ...live.temps.map(t => ({ type: 'property', name: 'tmp', to: t.id })),
    ] },
    { id: globalId, type: 'object', name: 'global', size: 64, edges: [{ type: 'property', name: '__eventEmitter', to: emitterId }] },
    { id: emitterId, type: 'object', name: 'EventEmitter', size: 128, edges: [{ type: 'property', name: '_listeners', to: listenersId }] },
    { id: listenersId, type: 'array', name: '_listeners', size: 32, edges: live.listeners.map((l, i) => ({ type: 'element', name: i, to: l.id })) },
    ...live.listeners, ...live.fibers, ...live.temps,
  ];
  return objects;
}

function makeSamplingProfile() {
  const frame = (name, line) => ({ functionName: name, url: 'http://localhost:8081/index.bundle?platform=android', lineNumber: line, columnNumber: 12, scriptId: '1' });
  return {
    head: {
      id: 1, selfSize: 0,
      callFrame: frame('(root)', 0),
      children: [
        { id: 2, selfSize: 3_200_000, callFrame: frame('renderStoreDetailItem', 218), children: [] },
        { id: 3, selfSize: 1_450_000, callFrame: frame('useRecommendSubscription', 76), children: [] },
        { id: 4, selfSize: 480_000, callFrame: frame('Image.prefetch', 903), children: [] },
      ],
    },
    samples: [], timestamps: [],
  };
}

module.exports = { makeFixture, makeSamplingProfile, build };
