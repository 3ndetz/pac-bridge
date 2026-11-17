# POSIX installer recovery candidate

This directory preserves an unfinished Linux installer recovery implementation. It is experimental source and does not replace the product `scripts/` entrypoints. The candidate uses a separate v2 installation directory, kernel locks, immutable generation files and anonymous-inode publication. Legacy migration, pathname races and full crash/power-loss durability remain open; macOS is not supported by this design.

The synthetic Python fixture copies the candidate scripts into its own disposable repository and uses fake dependency commands. It can investigate filesystem and interruption behavior without a PAC login or a model. The real-smoke recipes have additional runtime/dependency requirements and must not be used as production acceptance or pointed at an existing user profile.

The documentation stored here describes the candidate, not the active installation workflow. Review every limitation before developing it further. The main integration test glob excludes this experimental directory.
