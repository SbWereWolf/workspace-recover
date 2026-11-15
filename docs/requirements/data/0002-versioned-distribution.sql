-- depends: 0001-initial-data
INSERT INTO requirements(id,level,status,text) VALUES
('SYS-WR-VERSIONED-DISTRIBUTION','system','current','Recovery tooling is distributed as immutable, identifiable versions that consumers can install reproducibly without manually exchanged archives, while existing workspaces, repositories and released versions are preserved.'),
('APP-WR-NPM-DISTRIBUTION','application','current','workspace-recover publishes a validated SemVer package from its matching GitHub version tag through GitHub Actions into the public npm registry. Package version, source commit and tag agree. Version 1.0.1 is the requested release; published 1.0.0 and existing tags remain unchanged. The package preserves its standalone Node built-ins-only runtime and CLI/flow semantics. Packed bytes and installation through one actual consumer mechanism are verified; unrelated consumer migration and deployment are excluded.'),
('APP-WR-LOCAL-BARE-REMOTE','application','current','workspace-recover has an intact local bare repository at /mnt/d/WORK/kv1me/planing/workspace-recover.git and a local-bare remote pointing there, while its GitHub origin, existing refs and working data are preserved. Actual live Poise consumers of the WR remote are identified and their applicable configuration is aligned through the configuration owner; historical receipts and unrelated settings are preserved.');
INSERT INTO requirement_links(system_id,application_id) VALUES
('SYS-WR-VERSIONED-DISTRIBUTION','APP-WR-NPM-DISTRIBUTION'),
('SYS-WR-VERSIONED-DISTRIBUTION','APP-WR-LOCAL-BARE-REMOTE');
UPDATE requirements_meta SET revision = 2 WHERE revision = 1;
