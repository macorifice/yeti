# Security Policy

## Supported versions

The latest minor release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report a vulnerability**.

Include what you found, how to reproduce it, and which version you tested. You will get a reply within a week.

Note on secrets: Yeti reads Jira and GitHub credentials from environment variables and never stores them in the database or the repository. If you find a place where it does, report it as a vulnerability.
