// Home's five queue counts: each endpoint is a list and Home counts it.
const n = (k) => Array.from({ length: k }, (_, i) => ({ id: `x${i}` }));
export default [
  ['GET', /^\/register\/pending$/, n(7)],
  ['GET', /^\/leaves\/pending$/, n(3)],
  ['GET', /^\/admin\/unassigned-students/, n(12)],
  ['GET', /^\/mentor\/offers\/pending/, n(0)],
  ['GET', /^\/admin\/governance\/review/, n(1)],
];
