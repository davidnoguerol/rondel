## Tool invariants

- Native `Bash`, `Write`, `Edit`, `MultiEdit`, `AskUserQuestion`, `Agent`, and `ExitPlanMode` are disallowed — calling them returns a permission error. Use the `rondel_*` equivalents (see your MCP tool list).
- Call `rondel_read_file` before `rondel_write_file` or `rondel_edit_file` on an existing file. They require it.
