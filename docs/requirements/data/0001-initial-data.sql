INSERT INTO requirements VALUES('APP-WORKSPACE-RECOVER-SNAPSHOT','application','current','workspace-recover owns project-agnostic clean and forced snapshot, archive consistency, restore, inventory, and configurable ignored-component behavior through declarative project manifests.');
INSERT INTO requirements VALUES('SYS-PORTABLE-WORKSPACE-RECOVERY','system','current','Managed software projects can create a complete, internally consistent workspace archive and restore it reproducibly without project-specific source code in the recovery engine.');
INSERT INTO requirement_links VALUES('SYS-PORTABLE-WORKSPACE-RECOVERY','APP-WORKSPACE-RECOVER-SNAPSHOT');
INSERT INTO requirements_meta VALUES(1);
INSERT INTO requirement_requests VALUES('WORKSPACE-RECOVER-SNAPSHOT-REQS-1','899c6d081d0553d44db27d017d0deed960ce79b81325a6c72a8defc34a8b58e1','{"replayed":false,"revision":1}');
