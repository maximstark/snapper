@echo off
rem Test stub for the GitHub CLI: records its arguments and the --body-file content, prints a fake issue URL.
node "%~dp0gh-stub.mjs" %*
exit /b %errorlevel%
