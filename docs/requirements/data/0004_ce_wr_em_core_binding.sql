-- depends: 0003-requirements-registry
-- Exact projection of accepted CAL Goal/R1 for same-Task native registration; current means required, not implemented.
INSERT INTO requirements(id,level,status,text) VALUES
('SYS-CE-WR-EM-SHARED-CONTRACT','system','current','Integrate a coherent modular command-execution core with preserved current chain/configuration capabilities, all agreed shared JSON/list/parameter/execution policies, a proven unique SemVer version and both consumers migrated to the same exact installed candidate without lost functionality/reliability.'),
('APP-CE-WR-EM-SHARED-CORE','application','current','Unify actual current CE primary chain features and accepted WR-core mechanisms without dropping either; identify actual source/target versions and preserve foreign WIP.');
INSERT INTO requirement_links(system_id,application_id) VALUES ('SYS-CE-WR-EM-SHARED-CONTRACT','APP-CE-WR-EM-SHARED-CORE');
UPDATE requirements_meta SET revision=revision+1;
