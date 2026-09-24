import type { ScopedDb } from "../../db/scoped.js";
import { audit, personActor } from "../audit/audit.js";
import { asPrincipal, NotFoundError, RuleViolation, type AuthzContext } from "../authz/authz.js";
import { toCsv } from "../enterprise/enterprise-service.js";

export interface CpdAwardRow {
  id: string;
  courseTitle: string;
  tier: string;
  organisationName: string;
  value: number;
  unit: string;
  awardedAt: Date;
}

export interface CpdSummary {
  awards: CpdAwardRow[];
  /** Totals by unit, for the whole period and by calendar year (Europe/Dublin). Units are never mixed. */
  totals: { unit: string; lifetime: number; byYear: Record<string, number> }[];
  years: string[];
}

export const cpdYearOf = (d: Date) => new Intl.DateTimeFormat("en-IE", { year: "numeric", timeZone: "Europe/Dublin" }).format(d);

/** LRN-05, LRN-06 (CPD part). A learner's own CPD, with totals and transcript exports. */
export class CpdService {
  constructor(private readonly db: ScopedDb) {}

  summary(ctx: AuthzContext, year?: string): Promise<CpdSummary> {
    return asPrincipal(this.db, ctx, "cpd.summary", async (trx) => {
      const rows = await trx.selectFrom("cpd_award as a").innerJoin("course as c", "c.id", "a.course_id").innerJoin("organisation as o", "o.id", "a.organisation_id")
        .select(["a.id", "c.title", "c.tier", "o.name as org", "a.value", "a.unit", "a.awarded_at"])
        .where("a.person_id", "=", ctx.personId).orderBy("a.awarded_at", "desc").execute();
      const all = rows.map((r) => ({ id: r.id, courseTitle: r.title, tier: r.tier, organisationName: r.org, value: Number(r.value), unit: r.unit, awardedAt: r.awarded_at }));
      const totals = new Map<string, { unit: string; lifetime: number; byYear: Record<string, number> }>();
      for (const a of all) {
        const t = totals.get(a.unit) ?? { unit: a.unit, lifetime: 0, byYear: {} };
        t.lifetime += a.value;
        const y = cpdYearOf(a.awardedAt);
        t.byYear[y] = (t.byYear[y] ?? 0) + a.value;
        totals.set(a.unit, t);
      }
      const years = [...new Set(all.map((a) => cpdYearOf(a.awardedAt)))].sort().reverse();
      return { awards: year ? all.filter((a) => cpdYearOf(a.awardedAt) === year) : all, totals: [...totals.values()], years };
    });
  }

  /** The headline number is shown only for a single unit, so different units are never added together. */
  async thisYear(ctx: AuthzContext, now = new Date()): Promise<{ total: number; unit: string | null }> {
    const s = await this.summary(ctx);
    const first = s.totals[0];
    if (s.totals.length !== 1 || !first) return { total: 0, unit: null };
    return { total: first.byYear[cpdYearOf(now)] ?? 0, unit: first.unit };
  }

  async transcriptCsv(ctx: AuthzContext, requestId: string | null, year?: string): Promise<string> {
    const s = await this.summary(ctx, year);
    const rows: (string | number | null)[][] = [["Course", "Tier", "Provided by", "CPD value", "Unit", "Awarded (UTC)"]];
    for (const a of s.awards) rows.push([a.courseTitle, a.tier, a.organisationName, a.value, a.unit, a.awardedAt.toISOString()]);
    await asPrincipal(this.db, ctx, "cpd.export", (trx) =>
      audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "cpd.transcript_exported", entityType: "person", entityId: ctx.personId, after: { rows: s.awards.length, year: year ?? null }, requestId }),
    );
    return toCsv(rows);
  }

  /** TCGI admin: set or clear a course's CPD value. Existing awards are never changed. */
  setCourseCpd(ctx: AuthzContext, courseId: string, value: number | null, unit: string | null, requestId: string | null) {
    if (!ctx.platform) throw new NotFoundError("course");
    if ((value === null) !== (unit === null) || (value !== null && (!(value > 0) || value > 1000)) || (unit !== null && !unit.trim())) {
      throw new RuleViolation("Enter both a positive CPD value and its unit, or leave both empty.", "invalid_cpd");
    }
    return asPrincipal(this.db, ctx, "admin.cpd", async (trx) => {
      const before = await trx.selectFrom("course").select(["cpd_value", "cpd_unit"]).where("id", "=", courseId).executeTakeFirst();
      if (!before) throw new NotFoundError("course");
      await trx.updateTable("course").set({ cpd_value: value, cpd_unit: unit?.trim().slice(0, 40) ?? null }).where("id", "=", courseId).execute();
      await audit(trx, { actor: personActor(ctx.personId, ctx.displayName), action: "course.cpd_changed", entityType: "course", entityId: courseId, before, after: { cpd_value: value, cpd_unit: unit },
        reason: "applies to future completions only", requestId });
    });
  }
}
