DELETE FROM requirement_links WHERE system_id='SYS-CE-WR-EM-SHARED-CONTRACT' AND application_id='APP-CE-WR-EM-SHARED-CORE';
DELETE FROM requirements WHERE id IN ('SYS-CE-WR-EM-SHARED-CONTRACT','APP-CE-WR-EM-SHARED-CORE');
UPDATE requirements_meta SET revision=revision-1;
