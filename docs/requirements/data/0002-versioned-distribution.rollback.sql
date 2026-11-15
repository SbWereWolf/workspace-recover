-- depends: 0001-initial-data
DELETE FROM requirement_links WHERE system_id = 'SYS-WR-VERSIONED-DISTRIBUTION' AND application_id IN ('APP-WR-NPM-DISTRIBUTION', 'APP-WR-LOCAL-BARE-REMOTE');
DELETE FROM requirements WHERE id IN ('APP-WR-NPM-DISTRIBUTION', 'APP-WR-LOCAL-BARE-REMOTE', 'SYS-WR-VERSIONED-DISTRIBUTION');
UPDATE requirements_meta SET revision = 1 WHERE revision = 2;
