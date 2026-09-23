from __future__ import annotations

import os
import shutil
import site
import sys
import tempfile
import unittest
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib import import_module, metadata
from pathlib import Path
from types import MappingProxyType, ModuleType
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from dulwich.repo import Repo

from bayma_toolbelt_process import (
    DEFAULT_OUTPUT_LIMIT_BYTES,
    DEFAULT_TOOL_TIMEOUT_SECONDS,
    PythonToolResult,
    run_bounded_command,
)

SUPPORTED_PYTHON = (3, 12)
SUPPORTED_PYTHON_SPEC = ">=3.12,<3.13"
TOOLBELT_ROOT = Path(__file__).resolve().parent
# bayma installs the toolbelt with its runtimes, so bayma is also how to repair it.
REPAIR = "Reinstall it with: npx @bayma-repl/bayma doctor"

_DISTRIBUTIONS = {
    "ast_grep": "ast-grep-py",
    "binaryornot": "binaryornot",
    "cachetools": "cachetools",
    "dulwich": "dulwich",
    "editorconfig": "EditorConfig",
    "griffe": "griffe",
    "jedi": "jedi",
    "json5": "json5",
    "libcst": "libcst",
    "markdown_it": "markdown-it-py",
    "more_itertools": "more-itertools",
    "packaging": "packaging",
    "pathspec": "pathspec",
    "ruamel_yaml": "ruamel.yaml",
    "tomlkit": "tomlkit",
    "wcmatch": "wcmatch",
    "basedpyright": "basedpyright",
    "pygls": "pygls",
    "watchfiles": "watchfiles",
    "ripgrep": "ripgrep-bin",
    "pytest": "pytest",
    "pytest_asyncio": "pytest-asyncio",
    "ruff": "ruff",
}


def _require_supported_python() -> None:
    running = sys.version_info[:2]
    if running != SUPPORTED_PYTHON:
        expected = ".".join(map(str, SUPPORTED_PYTHON))
        actual = ".".join(map(str, running))
        expected_site_packages = (
            TOOLBELT_ROOT
            / ".venv"
            / "lib"
            / f"python{expected}"
            / "site-packages"
        )
        raise RuntimeError(
            f"bayma-toolbelt requires Python {expected}; this session is using "
            f"Python {actual} at {sys.executable}. Expected the toolbelt environment "
            f"at {expected_site_packages}. {REPAIR}"
        )


def _activate_environment(toolbelt_root: Path | None = None) -> Path:
    toolbelt_root = TOOLBELT_ROOT if toolbelt_root is None else Path(toolbelt_root).resolve()
    python_version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    site_packages = toolbelt_root / ".venv" / "lib" / python_version / "site-packages"
    if not site_packages.is_dir():
        raise RuntimeError(
            "The bayma-toolbelt Python environment is missing or was "
            f"installed for a different Python version. {REPAIR}"
        )

    site.addsitedir(str(site_packages))
    while str(site_packages) in sys.path:
        sys.path.remove(str(site_packages))
    sys.path.insert(0, str(site_packages))
    return site_packages


def _resolve_directory(cwd: Path | str | None = None) -> Path:
    current = Path.cwd() if cwd is None else Path(cwd)
    current = current.expanduser().resolve()
    return current.parent if current.is_file() else current


def _find_repo_root(cwd: Path | str | None = None) -> Path | None:
    current = _resolve_directory(cwd)
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def _resolve_executable(name: str, toolbelt_root: Path = TOOLBELT_ROOT) -> Path:
    executable = toolbelt_root / ".venv" / "bin" / name
    if not (executable.is_file() and os.access(executable, os.X_OK)):
        raise RuntimeError(f"The toolbelt's {name} executable is unavailable. {REPAIR}")
    return executable


def atomic_write(
    path: Path | str,
    data: str | bytes,
    *,
    encoding: str = "utf-8",
    mode: int | None = None,
) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    binary = isinstance(data, bytes)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent,
        prefix=f".{target.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        if binary:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        else:
            with os.fdopen(descriptor, "w", encoding=encoding, newline="") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        if mode is not None:
            temporary.chmod(mode)
        os.replace(temporary, target)
        return target
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def discover_package_roots(root: Path | str) -> tuple[Path, ...]:
    root = Path(root).resolve()
    markers = {"package.json", "pyproject.toml"}
    ignored = {".git", ".venv", "node_modules"}
    roots: set[Path] = set()
    for directory, child_directories, filenames in os.walk(root):
        child_directories[:] = [
            name for name in child_directories if name not in ignored
        ]
        if markers.intersection(filenames):
            roots.add(Path(directory))
    return tuple(sorted(roots))


def run_unittest_suite(
    modules: str | Sequence[str],
    *,
    verbosity: int = 1,
) -> unittest.result.TestResult:
    names = [modules] if isinstance(modules, str) else list(modules)
    suite = unittest.defaultTestLoader.loadTestsFromNames(names)
    return unittest.TextTestRunner(verbosity=verbosity).run(suite)


def _normalize_tool_targets(
    targets: str | Path | Sequence[str | Path],
) -> tuple[str, ...]:
    raw_targets = (targets,) if isinstance(targets, (str, Path)) else tuple(targets)
    normalized = tuple(str(target) for target in raw_targets)
    if not normalized:
        raise ValueError("At least one explicit test or check target is required")
    if any(not target or target.startswith("-") for target in normalized):
        raise ValueError("Tool targets must be non-empty paths, not options")
    return normalized


def _normalize_extra_args(extra_args: Sequence[str]) -> tuple[str, ...]:
    return tuple(str(argument) for argument in extra_args)


def _resolve_project_environment(project_root: Path | str) -> tuple[Path, Path]:
    root = Path(project_root).expanduser().resolve()
    missing = [
        path.name
        for path in (root / "pyproject.toml", root / "uv.lock")
        if not path.is_file()
    ]
    if missing:
        raise RuntimeError(
            f"Python project {root} is missing its reproducible boundary: "
            f"{', '.join(missing)}"
        )
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("uv is unavailable on PATH")
    return root, Path(uv).resolve()


def _assert_project_lock_current(
    project_root: Path,
    uv: Path,
    *,
    timeout_seconds: float,
    output_limit_bytes: int,
) -> None:
    result = run_bounded_command(
        (uv, "lock", "--check", "--project", project_root),
        cwd=project_root,
        timeout_seconds=timeout_seconds,
        output_limit_bytes=output_limit_bytes,
    )
    if not result.successful:
        detail = (result.stderr or result.stdout).strip()
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(
            f"Python project {project_root} has a missing or stale uv lock{suffix}"
        )


def run_pytest(
    targets: str | Path | Sequence[str | Path],
    *,
    extra_args: Sequence[str] = (),
    cwd: Path | str | None = None,
    timeout_seconds: float = DEFAULT_TOOL_TIMEOUT_SECONDS,
    output_limit_bytes: int = DEFAULT_OUTPUT_LIMIT_BYTES,
) -> PythonToolResult:
    normalized_targets = _normalize_tool_targets(targets)
    working_directory = Path.cwd() if cwd is None else Path(cwd)
    return run_bounded_command(
        (
            _resolve_executable("python"),
            "-m",
            "pytest",
            *_normalize_extra_args(extra_args),
            *normalized_targets,
        ),
        cwd=working_directory,
        timeout_seconds=timeout_seconds,
        output_limit_bytes=output_limit_bytes,
    )


def run_project_pytest(
    project_root: Path | str,
    targets: str | Path | Sequence[str | Path],
    *,
    extra_args: Sequence[str] = (),
    timeout_seconds: float = DEFAULT_TOOL_TIMEOUT_SECONDS,
    output_limit_bytes: int = DEFAULT_OUTPUT_LIMIT_BYTES,
) -> PythonToolResult:
    normalized_targets = _normalize_tool_targets(targets)
    root, uv = _resolve_project_environment(project_root)
    _assert_project_lock_current(
        root,
        uv,
        timeout_seconds=timeout_seconds,
        output_limit_bytes=output_limit_bytes,
    )
    return run_bounded_command(
        (
            uv,
            "run",
            "--project",
            root,
            "--frozen",
            "pytest",
            *_normalize_extra_args(extra_args),
            *normalized_targets,
        ),
        cwd=root,
        timeout_seconds=timeout_seconds,
        output_limit_bytes=output_limit_bytes,
    )


def run_ruff(
    targets: str | Path | Sequence[str | Path],
    *,
    extra_args: Sequence[str] = (),
    cwd: Path | str | None = None,
    timeout_seconds: float = DEFAULT_TOOL_TIMEOUT_SECONDS,
    output_limit_bytes: int = DEFAULT_OUTPUT_LIMIT_BYTES,
) -> PythonToolResult:
    normalized_targets = _normalize_tool_targets(targets)
    working_directory = Path.cwd() if cwd is None else Path(cwd)
    return run_bounded_command(
        (
            _resolve_executable("ruff"),
            "check",
            *_normalize_extra_args(extra_args),
            *normalized_targets,
        ),
        cwd=working_directory,
        timeout_seconds=timeout_seconds,
        output_limit_bytes=output_limit_bytes,
    )


def run_project_ruff(
    project_root: Path | str,
    targets: str | Path | Sequence[str | Path],
    *,
    extra_args: Sequence[str] = (),
    timeout_seconds: float = DEFAULT_TOOL_TIMEOUT_SECONDS,
    output_limit_bytes: int = DEFAULT_OUTPUT_LIMIT_BYTES,
) -> PythonToolResult:
    normalized_targets = _normalize_tool_targets(targets)
    root, uv = _resolve_project_environment(project_root)
    _assert_project_lock_current(
        root,
        uv,
        timeout_seconds=timeout_seconds,
        output_limit_bytes=output_limit_bytes,
    )
    return run_bounded_command(
        (
            uv,
            "run",
            "--project",
            root,
            "--frozen",
            "ruff",
            "check",
            *_normalize_extra_args(extra_args),
            *normalized_targets,
        ),
        cwd=root,
        timeout_seconds=timeout_seconds,
        output_limit_bytes=output_limit_bytes,
    )


@dataclass(frozen=True, slots=True)
class PythonToolbelt:
    ast_grep: ModuleType
    binaryornot: ModuleType
    cachetools: ModuleType
    dulwich: ModuleType
    dulwich_repo: Repo | None
    editorconfig: ModuleType
    griffe: ModuleType
    jedi: ModuleType
    json5: ModuleType
    libcst: ModuleType
    markdown_it: ModuleType
    more_itertools: ModuleType
    packaging: ModuleType
    pathspec: ModuleType
    ruamel_yaml: ModuleType
    tomlkit: ModuleType
    wcmatch: ModuleType
    pytest: ModuleType
    pytest_asyncio: ModuleType
    basedpyright: Path
    pygls: ModuleType
    watchfiles: ModuleType
    ripgrep: Path
    ruff: Path
    versions: Mapping[str, str]
    atomic_write: Callable[..., Path]
    discover_package_roots: Callable[[Path | str], tuple[Path, ...]]
    run_pytest: Callable[..., PythonToolResult]
    run_project_pytest: Callable[..., PythonToolResult]
    run_ruff: Callable[..., PythonToolResult]
    run_project_ruff: Callable[..., PythonToolResult]
    run_unittest_suite: Callable[..., unittest.result.TestResult]


class ToolbeltState(TypedDict):
    repo_root: Path | None
    toolbelt_site_packages: Path
    toolbelt: PythonToolbelt


def _load_toolbelt(repo_root: Path | None) -> PythonToolbelt:
    for submodule in (
        "binaryornot.check",
        "dulwich.objects",
        "dulwich.porcelain",
        "dulwich.repo",
        "packaging.requirements",
        "packaging.specifiers",
        "packaging.version",
        "pygls.lsp.server",
        "pytest_asyncio.plugin",
        "wcmatch.fnmatch",
        "wcmatch.glob",
        "wcmatch.pathlib",
    ):
        import_module(submodule)

    modules = {
        "ast_grep": import_module("ast_grep_py"),
        "binaryornot": import_module("binaryornot"),
        "cachetools": import_module("cachetools"),
        "dulwich": import_module("dulwich"),
        "editorconfig": import_module("editorconfig"),
        "griffe": import_module("griffe"),
        "jedi": import_module("jedi"),
        "json5": import_module("json5"),
        "libcst": import_module("libcst"),
        "markdown_it": import_module("markdown_it"),
        "more_itertools": import_module("more_itertools"),
        "packaging": import_module("packaging"),
        "pathspec": import_module("pathspec"),
        "ruamel_yaml": import_module("ruamel.yaml"),
        "tomlkit": import_module("tomlkit"),
        "wcmatch": import_module("wcmatch"),
        "pytest": import_module("pytest"),
        "pytest_asyncio": import_module("pytest_asyncio"),
        "pygls": import_module("pygls"),
        "watchfiles": import_module("watchfiles"),
    }
    versions = MappingProxyType(
        {
            label: metadata.version(distribution)
            for label, distribution in _DISTRIBUTIONS.items()
        }
    )
    return PythonToolbelt(
        **modules,
        dulwich_repo=(
            None if repo_root is None else modules["dulwich"].repo.Repo(repo_root)
        ),
        basedpyright=_resolve_executable("basedpyright"),
        ripgrep=_resolve_executable("rg"),
        ruff=_resolve_executable("ruff"),
        versions=versions,
        atomic_write=atomic_write,
        discover_package_roots=discover_package_roots,
        run_pytest=run_pytest,
        run_project_pytest=run_project_pytest,
        run_ruff=run_ruff,
        run_project_ruff=run_project_ruff,
        run_unittest_suite=run_unittest_suite,
    )


def open_toolbelt(*, cwd: Path | str | None = None) -> ToolbeltState:
    """Activate the toolbelt environment and return reusable REPL state.

    `repo_root` is the Git repository containing `cwd`, or None outside one,
    in which case the toolbelt has no bound `dulwich_repo`.
    """
    _require_supported_python()
    site_packages = _activate_environment()
    repo_root = _find_repo_root(cwd)
    return {
        "repo_root": repo_root,
        "toolbelt_site_packages": site_packages,
        "toolbelt": _load_toolbelt(repo_root),
    }


__all__ = [
    "PythonToolResult",
    "PythonToolbelt",
    "SUPPORTED_PYTHON",
    "SUPPORTED_PYTHON_SPEC",
    "ToolbeltState",
    "atomic_write",
    "discover_package_roots",
    "open_toolbelt",
    "run_project_pytest",
    "run_project_ruff",
    "run_pytest",
    "run_ruff",
    "run_unittest_suite",
]
