-- depends: 0002-versioned-distribution
INSERT INTO requirements(id,level,status,text) VALUES
('SYS-WR-REQUIREMENTS-TRACEABILITY','system','current','workspace-recover maintains its own reproducible requirements registry with explicit System to Application to Task traceability, preserved history and independently verifiable migration results, without depending on ERP-owned data or working materials.'),
('APP-WR-REQUIREMENTS-REGISTRY','application','current','The WR working requirements database resides at docs/requirements/requirements.sqlite and live Poise configuration selects it. Every schema/data migration, rollback and schema bootstrap belongs to WR under version control. A pinned WR-owned yoyo dependency and Poise-compatible histories support apply, rollback and reconstruction. Configuration examples are versioned; working configuration, database, sidecars, locks and tool environment are excluded from Git/npm. Existing requirements and receipts are preserved; the former database is removed only after verified transfer. Instructions document real paths and operations; ERP is left unchanged.');
INSERT INTO requirement_links(system_id,application_id) VALUES
('SYS-WR-REQUIREMENTS-TRACEABILITY','APP-WR-REQUIREMENTS-REGISTRY');
UPDATE requirements_meta SET revision = 3 WHERE revision = 2;
