@echo off
rem Castalia memory guard entry (called by Scheduled Task; runs and exits)
rem NOTE: keep this file ASCII-only -- cmd reads .cmd in the OEM codepage,
rem so non-ASCII comments get mangled and their tail is executed as commands.
rem The scheduled task itself now calls the exe directly; this file is a manual fallback.
set PYTHONPATH=
"D:\AI\castalia\run\Castalia\Castalia\Castalia.exe" "D:\AI\castalia\run\Castalia\scripts\castalia_guard.py"
