/** Authenticated, CSRF-protected skill management under /admin/skills. No code execution, no network fetches. */
import type { Express, Request, Response, NextFunction } from 'express';
import type { SqliteStore } from '../store/sqlite.js';
import { MAX_SKILLS_PER_USER, validateSkill, validSkillId } from './skills.js';
import { skillsPage } from '../pages/skills.js';

const form = (req: Request, key: string) => { const v = (req.body as Record<string, unknown> | undefined)?.[key]; return typeof v === 'string' ? v : ''; };
type Mw = (req: Request, res: Response, next: NextFunction) => unknown;

export function registerSkillsRoutes(app: Express, store: SqliteStore, requireLogin: Mw, requireCsrf: Mw, currentUser: (req: Request) => string | null | undefined): void {
  const render = (req: Request, res: Response, status = 200, error?: string) => {
    const user = currentUser(req)!;
    const prefill = typeof req.query.id === 'string' && validSkillId(req.query.id) ? req.query.id : '';
    const notice = req.query.done === 'imported' ? 'Skill approved and available to your MCP clients.'
      : req.query.done === 'removed' ? 'Skill removed.' : req.query.done === 'rejected' ? 'Request dismissed.' : undefined;
    res.status(status).type('html').send(skillsPage({ skills: store.listSkills(user), requests: store.listSkillRequests(user), prefill, error, notice }));
  };
  app.get('/admin/skills', requireLogin, (req, res) => render(req, res));
  app.post('/admin/skills/import', requireLogin, requireCsrf, (req, res) => {
    try {
      const user = currentUser(req)!;
      if (form(req, 'trust') !== 'yes') throw Error('You must explicitly review and approve skill instructions.');
      const id = form(req, 'id').trim();
      if (!validSkillId(id)) throw Error('Invalid skill ID');
      const prior = store.getSkill(user, id);
      if (!prior && store.listSkills(user).length >= MAX_SKILLS_PER_USER) throw Error(`Maximum ${MAX_SKILLS_PER_USER} skills. Remove one first.`);
      const row = validateSkill({ id, name: form(req, 'name'), description: form(req, 'description'), source: form(req, 'source'),
        files: [{ path: 'SKILL.md', contents: form(req, 'markdown') }] }, user, prior?.created_at);
      store.saveSkill(row);
      res.redirect(303, '/admin/skills?done=imported');
    } catch (e) { render(req, res, 400, e instanceof Error ? e.message : 'Skill import failed'); }
  });
  app.post('/admin/skills/delete', requireLogin, requireCsrf, (req, res) => {
    const id = form(req, 'id'); if (validSkillId(id)) store.deleteSkill(currentUser(req)!, id);
    res.redirect(303, '/admin/skills?done=removed');
  });
  app.post('/admin/skills/reject', requireLogin, requireCsrf, (req, res) => {
    const id = form(req, 'id'); if (/^sr_[A-Za-z0-9_-]{8,40}$/.test(id)) store.deleteSkillRequest(currentUser(req)!, id);
    res.redirect(303, '/admin/skills?done=rejected');
  });
}
