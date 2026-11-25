-- risk_signal (global per account, as 0019 made it) takes the kinds the renewal's integrity bits
-- and the reports route's crashes raise; their weights live in risk/score.rules.ts.
alter table risk_signal drop constraint risk_signal_kind_check;
alter table risk_signal
    add constraint risk_signal_kind_check
    check (kind in ('loader_silent', 'software_device_key', 'new_country', 'debugger_attached',
                    'hardware_breakpoints', 'kernel_debugging', 'test_signing',
                    'signature_enforcement_off', 'code_writable', 'virtual_machine',
                    'unsigned_module', 'module_trap'));
