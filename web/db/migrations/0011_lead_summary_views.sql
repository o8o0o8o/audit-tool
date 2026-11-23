-- Lead summary per audit, read straight from the tables the loader fills (no table of its own).
-- One row per succeeded full or quick audit that the public site did not start. The signal set is
-- this view: to change it, write a new migration that replaces the view.
--
-- Rules kept from get_lead_summary: a blocked scan has no scores, no finding counts and no quick
-- wins; its facts are only those that do not depend on reading pages; its stack is shown only when
-- the homepage was read. Disclosure details never appear: only that outreach is blocked.
CREATE VIEW "lead_summary" AS
SELECT
  a.id AS audit_id,
  a.site_id,
  s.registrable_domain AS domain,
  s.host,
  a.mode,
  a.source,
  a.finished_at AS scanned_at,

  -- scan
  coalesce(q.state, 'ok') AS scan_quality,
  coalesce(q.pages_ok, 0) AS pages_read,
  coalesce(q.pages_blocked, 0) AS pages_blocked,
  q.bot_protection,

  -- outreach
  d.open_since IS NOT NULL AS outreach_blocked,
  p.company AS prospect_company,
  p.stage AS prospect_stage,
  p.fit_score AS prospect_fit_score,
  coalesce(p.do_not_contact, false) AS do_not_contact,

  -- scores (none for a blocked scan)
  CASE WHEN bl.blocked THEN NULL ELSE sc.overall END AS score_overall,
  CASE WHEN bl.blocked THEN NULL ELSE sc.seo END AS score_seo,
  CASE WHEN bl.blocked THEN NULL ELSE sc.performance END AS score_performance,
  CASE WHEN bl.blocked THEN NULL ELSE sc.accessibility END AS score_accessibility,
  CASE WHEN bl.blocked THEN NULL ELSE sc.security END AS score_security,
  CASE WHEN bl.blocked THEN NULL ELSE sc.technical END AS score_technical,
  CASE WHEN bl.blocked THEN NULL ELSE sc.agentic END AS score_agentic,
  CASE WHEN bl.blocked THEN NULL ELSE sc.performance_source END AS performance_source,

  -- issues (unverified findings; none for a blocked scan)
  CASE WHEN bl.blocked THEN 0 ELSE coalesce(f.total, 0) END AS issues_total,
  CASE WHEN bl.blocked THEN 0 ELSE coalesce(f.critical, 0) END AS issues_critical,
  CASE WHEN bl.blocked THEN 0 ELSE coalesce(f.high, 0) END AS issues_high,
  CASE WHEN bl.blocked THEN '{}'::jsonb ELSE coalesce(f.by_category, '{}'::jsonb) END AS issues_by_category,

  -- gate-verified facts of the latest gate run
  coalesce(lf.heavy, 0) AS facts_heavy,
  coalesce(lf.medium, 0) AS facts_medium,
  coalesce(lf.light, 0) AS facts_light,
  coalesce(lf.top, '[]'::jsonb) AS top_facts,
  g.run_at AS gate_run_at,
  coalesce(g.teaser_ready, false) AND d.open_since IS NULL AS teaser_ready,

  -- real-user speed (origin; phone when measured, else all devices)
  fm.lcp_p75,
  fm.inp_p75,
  fm.cls_p75,
  CASE
    WHEN fm.lcp_p75 IS NULL AND fm.cls_p75 IS NULL AND fm.inp_p75 IS NULL THEN NULL
    ELSE coalesce(fm.lcp_p75, 0) <= 2500 AND coalesce(fm.cls_p75, 0) <= 0.1 AND coalesce(fm.inp_p75, 0) <= 200
  END AS cwv_pass,

  -- stack (hidden for a blocked scan whose homepage was not read)
  CASE WHEN bl.show_stack THEN t.cms END AS cms,
  CASE WHEN bl.show_stack THEN t.framework END AS framework,
  CASE WHEN bl.show_stack THEN coalesce(t.cdn, sp.cdn) END AS cdn,
  CASE WHEN bl.show_stack THEN coalesce(t.eol, '{}') ELSE '{}' END AS eol_software,
  CASE WHEN bl.show_stack THEN t.consent END AS consent_tool,
  coalesce(ck.js_libraries, 0) AS vulnerable_js_libraries,

  -- tracking
  coalesce(tr.has_ga4, false) AS has_ga4,
  coalesce(tr.has_gtm, false) AS has_gtm,
  coalesce(tr.has_meta_pixel, false) AS has_meta_pixel,
  tr.ga4_sends_hits,

  -- site
  coalesce(sp.languages, '{}') AS languages,
  coalesce(sp.multilang, false) AS multilang,
  sp.has_contact_form,
  coalesce(array_length(sp.booking_links, 1), 0) > 0 AS has_booking_link,
  sp.llms_txt,
  (SELECT count(*)::int FROM jsonb_each_text(coalesce(sp.ai_crawler_rules, '{}'::jsonb)) r WHERE r.value = 'disallowed')
    AS ai_crawlers_blocked,

  -- email and domain
  ck.spf,
  ck.dmarc,

  -- next steps
  CASE WHEN bl.blocked THEN '[]'::jsonb ELSE coalesce(qw.wins, '[]'::jsonb) END AS quick_wins,
  '/internal/audits/' || a.id AS report_path,
  CASE WHEN sp.homepage_screenshot_artifact_id IS NOT NULL
    THEN '/internal/audits/' || a.id || '/a/' || sp.homepage_screenshot_artifact_id END AS homepage_screenshot_path
FROM "audits" a
JOIN "sites" s ON s.id = a.site_id
LEFT JOIN "scan_quality" q ON q.audit_id = a.id
LEFT JOIN "site_profiles" sp ON sp.audit_id = a.id
CROSS JOIN LATERAL (
  SELECT coalesce(q.state, 'ok') = 'blocked' AS blocked,
         coalesce(q.state, 'ok') <> 'blocked' OR coalesce(q.homepage_read, true) AS show_stack
) bl
LEFT JOIN LATERAL (
  SELECT min(created_at) AS open_since FROM "disclosures" WHERE site_id = a.site_id AND status = 'open'
) d ON true
LEFT JOIN LATERAL (
  SELECT company, stage, fit_score, do_not_contact FROM "prospects"
  WHERE registrable_domains && ARRAY[s.registrable_domain] ORDER BY company LIMIT 1
) p ON true
LEFT JOIN LATERAL (
  SELECT
    max(score) FILTER (WHERE category = 'overall') AS overall,
    max(score) FILTER (WHERE category = 'seo') AS seo,
    max(score) FILTER (WHERE category = 'performance') AS performance,
    max(score) FILTER (WHERE category = 'accessibility') AS accessibility,
    max(score) FILTER (WHERE category = 'security') AS security,
    max(score) FILTER (WHERE category = 'technical') AS technical,
    max(score) FILTER (WHERE category = 'agentic') AS agentic,
    max(source) FILTER (WHERE category = 'performance') AS performance_source
  FROM "scores" WHERE audit_id = a.id
) sc ON true
LEFT JOIN LATERAL (
  SELECT sum(n)::int AS total,
         coalesce(sum(n) FILTER (WHERE severity = 'critical'), 0)::int AS critical,
         coalesce(sum(n) FILTER (WHERE severity = 'high'), 0)::int AS high,
         (SELECT jsonb_object_agg(category, c) FROM (
            SELECT category, count(*)::int AS c FROM "findings" WHERE audit_id = a.id GROUP BY category
          ) x) AS by_category
  FROM (SELECT severity, count(*) AS n FROM "findings" WHERE audit_id = a.id GROUP BY severity) y
) f ON true
LEFT JOIN LATERAL (
  SELECT id, run_at, teaser_ready FROM "lead_gate_runs" WHERE audit_id = a.id ORDER BY run_at DESC LIMIT 1
) g ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE weight = 'heavy')::int AS heavy,
    count(*) FILTER (WHERE weight = 'medium')::int AS medium,
    count(*) FILTER (WHERE weight = 'light')::int AS light,
    (SELECT jsonb_agg(jsonb_build_object('type', type, 'weight', weight, 'fact', fact, 'url', url)
                      ORDER BY rnk, id)
       FROM (
         SELECT lf2.*, CASE weight WHEN 'heavy' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END AS rnk
         FROM "lead_facts" lf2
         WHERE lf2.gate_run_id = g.id AND lf2.gate = 'pass'
           AND (NOT bl.blocked OR lf2.depends_on = 'dns'
                OR (lf2.depends_on = 'homepage' AND coalesce(q.homepage_read, true)))
         ORDER BY rnk, id LIMIT 3
       ) top3) AS top
  FROM "lead_facts" lf1
  WHERE lf1.gate_run_id = g.id AND lf1.gate = 'pass'
    AND (NOT bl.blocked OR lf1.depends_on = 'dns'
         OR (lf1.depends_on = 'homepage' AND coalesce(q.homepage_read, true)))
) lf ON true
LEFT JOIN LATERAL (
  SELECT lcp_p75, inp_p75, cls_p75 FROM "field_metrics"
  WHERE audit_id = a.id AND scope = 'origin'
  ORDER BY CASE upper(form_factor) WHEN 'PHONE' THEN 0 WHEN 'ALL' THEN 1 ELSE 2 END LIMIT 1
) fm ON true
LEFT JOIN LATERAL (
  SELECT
    (array_agg(name ORDER BY name) FILTER (WHERE kind = 'cms'))[1] AS cms,
    (array_agg(name ORDER BY name) FILTER (WHERE kind = 'framework'))[1] AS framework,
    (array_agg(name ORDER BY name) FILTER (WHERE kind = 'cdn'))[1] AS cdn,
    (array_agg(name ORDER BY name) FILTER (WHERE kind = 'consent'))[1] AS consent,
    array_agg(name || coalesce(' ' || version, '') ORDER BY name)
      FILTER (WHERE eol_date IS NOT NULL AND eol_date <= coalesce(a.finished_at, now())::date) AS eol
  FROM "technologies" WHERE audit_id = a.id
) t ON true
LEFT JOIN LATERAL (
  SELECT bool_or(kind = 'ga4') AS has_ga4, bool_or(kind = 'gtm') AS has_gtm,
         bool_or(kind = 'meta_pixel') AS has_meta_pixel,
         bool_or(sends_hits) FILTER (WHERE kind = 'ga4') AS ga4_sends_hits
  FROM "tracking_ids" WHERE audit_id = a.id
) tr ON true
LEFT JOIN LATERAL (
  SELECT
    max(status) FILTER (WHERE check_id = 'spf') AS spf,
    max(status) FILTER (WHERE check_id = 'dmarc') AS dmarc,
    max(CASE WHEN check_id = 'js-libraries' AND status NOT IN ('pass', 'skipped')
             THEN CASE WHEN jsonb_typeof(details) = 'array' THEN greatest(jsonb_array_length(details), 1) ELSE 1 END
        END) AS js_libraries
  FROM "site_checks" WHERE audit_id = a.id
) ck ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('title', title, 'impact', impact, 'effort', effort) ORDER BY rank) AS wins
  FROM (SELECT title, impact, effort, rank FROM "recommendations" WHERE audit_id = a.id ORDER BY rank LIMIT 3) r
) qw ON true
WHERE a.status = 'succeeded' AND a.mode IN ('full', 'quick') AND a.source <> 'public';
--> statement-breakpoint
-- The newest summary of each site and scan type: `select * from lead_summary_latest` is every lead summary.
CREATE VIEW "lead_summary_latest" AS
SELECT DISTINCT ON (site_id, mode) *
FROM "lead_summary"
ORDER BY site_id, mode, scanned_at DESC NULLS LAST, audit_id;
