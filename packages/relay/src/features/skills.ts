/**
 * Owner-approved skill library (opt-in: BRC_SKILLS=1). Skill text is untrusted
 * instruction DATA: it is stored and returned verbatim, never executed, installed or fetched.
 */
export interface SkillFile { path: string; contents: string }
export interface SkillRow { id: string; user_id: string; name: string; description: string; source: string; files_json: string; created_at: number; updated_at: number }
export interface SkillRequest { id: string; user_id: string; skill_id: string; client: string; reason: string; created_at: number }

export const MAX_SKILLS_PER_USER = 100;
export const MAX_SKILL_BYTES = 128 * 1024;
export const MAX_SKILL_FILES = 32;
const ID = /^[a-zA-Z0-9][\w.-]*(?:\/[a-zA-Z0-9][\w.-]*){1,3}$/;
const FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\w .@/-]{1,160}$/;

export function validSkillId(id: unknown): id is string { return typeof id === 'string' && id.length <= 160 && ID.test(id); }

export function validateSkill(input: unknown, user: string, existingCreatedAt?: number): SkillRow {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Expected skill object');
  const a = input as Record<string, unknown>;
  if (!validSkillId(a.id)) throw Error('Skill ID must look like owner/repo/skill or local/name');
  const name = String(a.name ?? '').trim(), description = String(a.description ?? '').trim(), source = String(a.source ?? '').trim();
  if (!name || name.length > 100 || description.length > 600 || source.length > 400) throw Error('Invalid skill name, description or source');
  const files = a.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_SKILL_FILES) throw Error(`Expected 1-${MAX_SKILL_FILES} skill files`);
  let total = 0; const seen = new Set<string>();
  const clean: SkillFile[] = files.map((file: unknown) => {
    if (!file || typeof file !== 'object') throw Error('Invalid skill file');
    const f = file as Record<string, unknown>;
    if (typeof f.path !== 'string' || !FILE.test(f.path) || typeof f.contents !== 'string') throw Error('Invalid skill path or content');
    if (seen.has(f.path)) throw Error('Duplicate skill path');
    seen.add(f.path); total += Buffer.byteLength(f.contents, 'utf8');
    if (total > MAX_SKILL_BYTES) throw Error('Skill content exceeds 128 KiB');
    return { path: f.path, contents: f.contents };
  });
  if (!seen.has('SKILL.md')) throw Error('SKILL.md is required');
  const now = Date.now();
  return { id: a.id, user_id: user, name, description, source, files_json: JSON.stringify(clean), created_at: existingCreatedAt ?? now, updated_at: now };
}
export function skillFile(skill: SkillRow, file = 'SKILL.md'): string | undefined {
  if (!FILE.test(file)) return;
  try { return (JSON.parse(skill.files_json) as SkillFile[]).find((x) => x.path === file)?.contents; } catch { return; }
}
export function fileNames(skill: SkillRow): string[] {
  try { return (JSON.parse(skill.files_json) as SkillFile[]).map((x) => x.path); } catch { return []; }
}
