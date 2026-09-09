// Validates /openapi.json against the GPT Actions rules we have hit: desc <= 300, object schemas need properties, components.schemas present, <= 30 ops.
const spec = await (await fetch(`${process.argv[2]}/openapi.json`)).json();
const problems = [];
const walk = (node, ctx) => {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${ctx}[${i}]`));
  if (!node || typeof node !== 'object') return;
  if (typeof node.description === 'string' && node.description.length > 300) problems.push(`${ctx}: description ${node.description.length} > 300`);
  if (node.type === 'object' && !node.properties) problems.push(`${ctx}: object without properties`);
  if ('$schema' in node) problems.push(`${ctx}: $schema present`);
  for (const [k, v] of Object.entries(node)) walk(v, `${ctx}.${k}`);
};
walk(spec.paths, 'paths');
if (!spec.components?.schemas || typeof spec.components.schemas !== 'object') problems.push('components.schemas missing');
const ops = Object.values(spec.paths).flatMap((p) => Object.keys(p)).length;
if (ops > 30) problems.push(`${ops} operations > 30`);
console.log(problems.length ? problems.join('\n') : `OK: ${ops} operations, all GPT Actions rules satisfied`);
process.exit(problems.length ? 1 : 0);
