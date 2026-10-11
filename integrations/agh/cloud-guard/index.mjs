import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const allowedTools = new Set(['industrial_read_input', 'industrial_get_document', 'industrial_search_catalog', 'industrial_review_order', 'industrial_geometry', 'industrial_request_clarification']);
const inside = (root, child) => { const rel = relative(root, child); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export async function checkCloudTool({ name, args }, policy) {
  if (!allowedTools.has(name)) return { allow: false, reason: 'Website tasks may execute only the registered industrial tools. General shell, filesystem, web and subagent tools are disabled.' };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) return { allow: false, reason: 'Invalid or oversized industrial arguments.' };
  const permittedPath = async path => {
    if (typeof path !== 'string') return false;
    const actual = await realpath(resolve(policy.root, path));
    const runs = JSON.parse(await readFile(policy.runRegistry, 'utf8'));
    if (!Array.isArray(runs) || runs.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) return false;
    const roots = await Promise.all([policy.uploadRoot, ...runs.map(id => resolve(policy.root, 'data/runs', id))].map(path => realpath(path)));
    return roots.some(root => inside(root, actual));
  };
  try {
    if (name === 'industrial_get_document') return { allow: false, reason: 'This website task exposes supplied PNG/JPEG/text files only. No unrelated local document records may be read.' };
    if (name === 'industrial_read_input' && !await permittedPath(args.path)) return { allow: false, reason: 'Only this task’s uploaded files and generated artifacts may be read.' };
    if (name === 'industrial_geometry') {
      if (!['build', 'validate', 'project', 'patch', 'assembly', 'compare_views'].includes(args.operation)) return { allow: false, reason: 'Unsupported geometry operation.' };
      if (args.operation === 'compare_views' && (!await permittedPath(args.input?.source?.path) || !await permittedPath(args.input?.projection?.path))) return { allow: false, reason: 'Comparison files must belong to this task.' };
    }
  } catch { return { allow: false, reason: 'The requested task file is unavailable or outside this task.' }; }
  return { allow: true };
}

/** The pinned AGH daemon only authorizes builtin tool image origins. Preserve the real
 * industrial read, but reuse pixels already attached by the runner instead of emitting
 * an unreadable custom-origin artifact link. Unattached images fail explicitly. */
export function sessionInlineImageResult({ name, args, result }, inlineImages = [], root = '') {
  if (name !== 'industrial_read_input' || result?.isError || !Array.isArray(result?.content)) return {};
  const images = result.content.filter(block => block.type === 'image');
  if (!images.length) return {};
  const matching = images.length === 1 && typeof args?.path === 'string' && inlineImages.find(image => (root ? resolve(root, image.path) === resolve(root, args.path) : image.path === args.path)
    && image.sha256 === images[0].ref?.sha256 && image.bytes === images[0].ref?.size && image.mime === images[0].mime);
  if (!matching) return { result: { isError: true, content: [{ type: 'text', text: 'IMAGE_NOT_ATTACHED: This image is not one of the original images attached to this task. The pinned AGH runtime cannot reload images produced by custom tools. Upload the image as a task input, or inspect generated SVG/text checks. No image pixels from this read have been presented to the model.' }], details: { success: false, code: 'IMAGE_NOT_ATTACHED', path: args?.path, pixelsPresented: false } } };
  const structured = { ...result.structured, sha256: matching.sha256, source: 'inline_session_image', pixelsAlreadyAttached: true, verifiedSameBytes: true };
  // The pinned author hook schema accepts details but not the ordinary tool's structured key.
  return { result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ ...structured, note: 'The actual file was read and its SHA-256, MIME and byte count match the original image already attached in this task’s user message. Inspect those existing image pixels; this result does not substitute an image description or inject a second artifact.' }) }], details: structured } };
}

export const cloudGuard = {
  inject: ['extension'],
  apply(ctx) {
    const api = ctx.extension();
    const policy = { root: process.env.AGH_INDUSTRIAL_ROOT, uploadRoot: process.env.AGH_CLOUD_UPLOAD_ROOT, runRegistry: process.env.AGH_CLOUD_RUN_REGISTRY };
    if (!policy.root || !policy.uploadRoot || !policy.runRegistry) throw new Error('Cloud task isolation policy is required.');
    const maxSteps = Number(process.env.AGH_CLOUD_MAX_STEPS || 12);
    const maxTokens = Number(process.env.AGH_CLOUD_MAX_TOKENS || 4096);
    const inlineImages = JSON.parse(process.env.AGH_CLOUD_INLINE_IMAGES || '[]');
    if (!Array.isArray(inlineImages) || inlineImages.length > 4 || inlineImages.some(image => typeof image.path !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || !['image/png', 'image/jpeg'].includes(image.mime))) throw new Error('Invalid task image identity manifest.');
    api.registerHook('tool_call', payload => checkCloudTool(payload, policy));
    api.registerHook('tool_result', payload => sessionInlineImageResult(payload, inlineImages, policy.root));
    api.registerHook('before_step', payload => payload.step > maxSteps ? { block: true, reason: 'Website task reached its maximum tool/model steps.' } : {});
    api.registerHook('before_request', () => ({ patch: { maxTokens } }));
    api.registerHook('context', () => ({ additionalContext: 'WEBSITE TASK POLICY: Only industrial_read_input, industrial_get_document, industrial_search_catalog, industrial_review_order, industrial_geometry and industrial_request_clarification are callable. General shell, file editing, web fetching and subagents are disabled. Read only explicitly supplied task files and files produced by this task. Ask for missing evidence instead of accessing other local resources.' }));
  },
};
