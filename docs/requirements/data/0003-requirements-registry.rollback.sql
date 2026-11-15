-- depends: 0002-versioned-distribution
DELETE FROM requirement_links WHERE system_id = 'SYS-WR-REQUIREMENTS-TRACEABILITY' AND application_id = 'APP-WR-REQUIREMENTS-REGISTRY';
DELETE FROM requirements WHERE id IN ('APP-WR-REQUIREMENTS-REGISTRY','SYS-WR-REQUIREMENTS-TRACEABILITY');
UPDATE requirements_meta SET revision = 2 WHERE revision = 3;
