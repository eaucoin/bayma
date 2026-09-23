from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import tomllib
import types
import unittest
from collections.abc import MutableMapping
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import ClassVar, Protocol, cast
from unittest.mock import patch

import bayma_toolbelt as subject

# The skill that documents this toolbelt, beside it in the repository; its
# examples must run against it.
SKILL_DOC = Path(__file__).resolve().parents[2] / "skills/bayma-toolbelt/SKILL.md"


def make_committed_repository(root: Path) -> Path:
    """A Git repository with one commit, for tests that need a bound repo."""
    environment = {
        "GIT_AUTHOR_NAME": "Toolbelt Test",
        "GIT_AUTHOR_EMAIL": "toolbelt@example.test",
        "GIT_COMMITTER_NAME": "Toolbelt Test",
        "GIT_COMMITTER_EMAIL": "toolbelt@example.test",
        "PATH": "/usr/bin:/bin",
    }
    (root / "README.md").write_text("fixture\n", encoding="utf-8")
    for arguments in (("init", "-q"), ("add", "README.md"), ("commit", "-qm", "fixture")):
        subprocess.run(("git", *arguments), cwd=root, env=environment, check=True)
    return root


class MutableToolbeltView(Protocol):
    ripgrep: Path


class ActivateEnvironmentTest(unittest.TestCase):
    def test_prepends_matching_toolbelt_site_packages(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            toolbelt_root = Path(temporary_directory)
            python_version = f"python{sys.version_info.major}.{sys.version_info.minor}"
            site_packages = (
                toolbelt_root / ".venv" / "lib" / python_version / "site-packages"
            )
            site_packages.mkdir(parents=True)

            activated = subject._activate_environment(toolbelt_root)
            self.addCleanup(
                lambda: (
                    sys.path.remove(str(site_packages))
                    if str(site_packages) in sys.path
                    else None
                )
            )

            self.assertEqual(activated, site_packages)
            self.assertEqual(sys.path[0], str(site_packages))

            activated_again = subject._activate_environment(toolbelt_root)
            self.assertEqual(activated_again, site_packages)
            self.assertEqual(sys.path.count(str(site_packages)), 1)

    def test_rejects_environment_for_a_different_python_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            toolbelt_root = Path(temporary_directory)
            wrong_site_packages = toolbelt_root / ".venv/lib/python0.0/site-packages"
            wrong_site_packages.mkdir(parents=True)

            with self.assertRaisesRegex(RuntimeError, "different Python version"):
                subject._activate_environment(toolbelt_root)

    def test_version_skew_fails_before_mutating_import_state(self) -> None:
        original_path = tuple(sys.path)
        with (
            patch.object(subject, "SUPPORTED_PYTHON", (0, 0)),
            self.assertRaisesRegex(
                RuntimeError,
                r"this session is using Python .*Expected the toolbelt environment.*"
                r"npx @bayma-repl/bayma doctor",
            ),
        ):
            subject.open_toolbelt(cwd=Path(__file__))

        self.assertEqual(tuple(sys.path), original_path)


class InterpreterContractTest(unittest.TestCase):
    def test_manifest_lock_loader_checker_and_docs_agree(self) -> None:
        self.assertEqual(subject.SUPPORTED_PYTHON, (3, 12))
        pyproject = tomllib.loads(
            (subject.TOOLBELT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        )
        lock_header = tomllib.loads(
            "\n".join(
                (subject.TOOLBELT_ROOT / "uv.lock")
                .read_text(encoding="utf-8")
                .splitlines()[:3]
            )
        )
        skill = SKILL_DOC.read_text(encoding="utf-8")
        expected_minor = ".".join(map(str, subject.SUPPORTED_PYTHON))

        self.assertEqual(
            pyproject["project"]["requires-python"],
            subject.SUPPORTED_PYTHON_SPEC,
        )
        self.assertEqual(
            lock_header["requires-python"],
            f"=={expected_minor}.*",
        )
        self.assertEqual(
            pyproject["tool"]["basedpyright"]["pythonVersion"],
            expected_minor,
        )
        self.assertIn(f".venv/lib/python{expected_minor}/site-packages", skill)
        self.assertIn("npx @bayma-repl/bayma doctor", skill)

    def test_documented_python_quickstart_executes_verbatim(self) -> None:
        skill = SKILL_DOC.read_text(encoding="utf-8")
        matched = re.search(
            r"### Python\n\nIn a bayma Python session:\n\n"
            r"```python\n(.*?)\n```",
            skill,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(matched)
        assert matched is not None
        expected_minor = ".".join(map(str, subject.SUPPORTED_PYTHON))
        namespace: dict[str, object] = {}
        # A working directory outside any repository, wherever the toolbelt is.
        with (
            tempfile.TemporaryDirectory() as outside_any_repository,
            patch.object(Path, "cwd", return_value=Path(outside_any_repository)),
        ):
            exec(matched.group(1), namespace)

        self.assertIsNone(namespace["repo_root"])
        self.assertEqual(
            namespace["toolbelt_site_packages"],
            subject.TOOLBELT_ROOT
            / f".venv/lib/python{expected_minor}/site-packages",
        )
        self.assertIsNone(
            cast(subject.PythonToolbelt, namespace["toolbelt"]).dulwich_repo
        )


class RepositoryHelpersTest(unittest.TestCase):
    def test_discovers_repo_from_a_nested_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo_root = Path(temporary_directory)
            (repo_root / ".git").mkdir()
            nested = repo_root / "one/two/three"
            nested.mkdir(parents=True)

            self.assertEqual(subject._find_repo_root(nested), repo_root)

    def test_reports_no_repo_outside_one(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            self.assertIsNone(subject._find_repo_root(temporary_directory))

    def test_discovers_javascript_and_python_package_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo_root = Path(temporary_directory)
            (repo_root / ".git").mkdir()
            javascript = repo_root / "apps/web"
            python = repo_root / "services/indexer"
            ignored = repo_root / "node_modules/dependency"
            for directory in (javascript, python, ignored):
                directory.mkdir(parents=True)
            (javascript / "package.json").write_text("{}", encoding="utf-8")
            (python / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
            (ignored / "package.json").write_text("{}", encoding="utf-8")

            self.assertEqual(
                subject.discover_package_roots(repo_root),
                (javascript, python),
            )

    def test_atomic_write_replaces_content_mode_and_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            target = Path(temporary_directory) / "nested/result.txt"

            returned = subject.atomic_write(target, "complete\n", mode=0o640)

            self.assertEqual(returned, target)
            self.assertEqual(target.read_text(encoding="utf-8"), "complete\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            self.assertFalse(list(target.parent.glob(f".{target.name}.*.tmp")))


class ToolbeltTest(unittest.TestCase):
    state: ClassVar[subject.ToolbeltState]
    toolbelt: ClassVar[subject.PythonToolbelt]

    @classmethod
    def setUpClass(cls) -> None:
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        repo_root = make_committed_repository(Path(directory.name).resolve())
        cls.state = subject.open_toolbelt(cwd=repo_root)
        cls.toolbelt = cls.state["toolbelt"]
        assert cls.toolbelt.dulwich_repo is not None
        cls.addClassCleanup(cls.toolbelt.dulwich_repo.close)

    def test_exposes_exact_pinned_versions(self) -> None:
        self.assertEqual(
            dict(self.toolbelt.versions),
            {
                "ast_grep": "0.45.0",
                "binaryornot": "0.6.0",
                "cachetools": "7.1.6",
                "dulwich": "1.2.12",
                "editorconfig": "0.17.1",
                "griffe": "2.1.0",
                "jedi": "0.20.0",
                "json5": "0.15.0",
                "libcst": "1.8.6",
                "markdown_it": "4.2.0",
                "more_itertools": "11.1.0",
                "packaging": "26.2",
                "pathspec": "1.1.1",
                "ruamel_yaml": "0.19.1",
                "tomlkit": "0.15.1",
                "wcmatch": "11.0",
                "basedpyright": "1.39.9",
                "pygls": "2.1.1",
                "watchfiles": "1.2.0",
                "ripgrep": "15.2.0",
                "pytest": "9.1.1",
                "pytest_asyncio": "1.4.0",
                "ruff": "0.16.0",
            },
        )

    def test_preloads_useful_package_submodules(self) -> None:
        self.assertTrue(hasattr(self.toolbelt.binaryornot, "check"))
        self.assertTrue(hasattr(self.toolbelt.dulwich, "porcelain"))
        self.assertTrue(hasattr(self.toolbelt.dulwich, "repo"))
        self.assertTrue(hasattr(self.toolbelt.packaging, "version"))
        self.assertTrue(hasattr(self.toolbelt.pygls, "lsp"))
        self.assertTrue(hasattr(self.toolbelt.wcmatch, "glob"))
        self.assertTrue(callable(self.toolbelt.pytest.main))
        self.assertTrue(hasattr(self.toolbelt.pytest_asyncio, "plugin"))

    def test_exposes_repository_bound_actual_dulwich_repo(self) -> None:
        repository = self.toolbelt.dulwich_repo
        assert repository is not None

        self.assertIsInstance(repository, self.toolbelt.dulwich.repo.Repo)
        self.assertEqual(Path(repository.path).resolve(), self.state["repo_root"])
        self.assertEqual(repository[repository.head()].id, repository.head())
        self.assertTrue(
            hasattr(self.toolbelt.dulwich.porcelain.status(repository), "staged")
        )

    def test_skill_examples_keep_hook_bearing_mutations_off_dulwich(self) -> None:
        skill = SKILL_DOC.read_text(encoding="utf-8")
        python_examples = "\n".join(
            re.findall(r"```python\n(.*?)\n```", skill, flags=re.DOTALL)
        )

        self.assertIn("toolbelt.dulwich.porcelain.status(", python_examples)
        self.assertIn("toolbelt.dulwich.porcelain.add(", python_examples)
        self.assertNotIn("toolbelt.dulwich.porcelain.commit(", python_examples)
        self.assertNotIn("toolbelt.dulwich.porcelain.push(", python_examples)

    def test_exposes_the_toolbelt_executables(self) -> None:
        for executable in (
            self.toolbelt.basedpyright,
            self.toolbelt.ripgrep,
            self.toolbelt.ruff,
        ):
            with self.subTest(executable=executable):
                self.assertTrue(executable.is_file())
                self.assertTrue(
                    executable.is_relative_to(subject.TOOLBELT_ROOT / ".venv")
                )

    def test_state_and_versions_are_immutable(self) -> None:
        mutable_toolbelt = cast(MutableToolbeltView, self.toolbelt)
        with self.assertRaises(FrozenInstanceError):
            mutable_toolbelt.ripgrep = Path("elsewhere")
        mutable_versions = cast(MutableMapping[str, str], self.toolbelt.versions)
        with self.assertRaises(TypeError):
            mutable_versions["ripgrep"] = "different"

    def test_runs_a_focused_unittest_module(self) -> None:
        module_name = "toolbelt_dynamic_test"
        module = types.ModuleType(module_name)

        class PassingTest(unittest.TestCase):
            def test_passes(self) -> None:
                self.assertTrue(True)

        PassingTest.__module__ = module_name
        module.__dict__["PassingTest"] = PassingTest
        sys.modules[module_name] = module
        self.addCleanup(sys.modules.pop, module_name)

        result = self.toolbelt.run_unittest_suite(module_name, verbosity=0)

        self.assertTrue(result.wasSuccessful())
        self.assertEqual(result.testsRun, 1)

    def test_rejects_implicit_repository_wide_test_and_check_runs(self) -> None:
        for runner in (
            self.toolbelt.run_pytest,
            self.toolbelt.run_ruff,
        ):
            with (
                self.subTest(runner=runner),
                self.assertRaisesRegex(ValueError, "explicit.*target"),
            ):
                runner(())

        for runner in (
            self.toolbelt.run_project_pytest,
            self.toolbelt.run_project_ruff,
        ):
            with (
                self.subTest(runner=runner),
                self.assertRaisesRegex(ValueError, "explicit.*target"),
            ):
                runner(subject.TOOLBELT_ROOT, ())

    def test_isolated_runner_imports_the_installed_toolbelt_from_repo_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            test_file = Path(temporary_directory) / "test_installed_toolbelt.py"
            test_file.write_text(
                "import bayma_toolbelt\n\n"
                "def test_installed_toolbelt():\n"
                "    assert bayma_toolbelt.TOOLBELT_ROOT.is_dir()\n",
                encoding="utf-8",
            )
            result = self.toolbelt.run_pytest(
                test_file,
                extra_args=("-q",),
                cwd=self.state["repo_root"],
                timeout_seconds=30,
            )

        self.assertTrue(result.successful, result.stdout + result.stderr)
        self.assertIn("1 passed", result.stdout)

    def test_child_interpreters_ignore_the_repl_interpreter_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            test_file = Path(temporary_directory) / "test_clean_interpreter.py"
            test_file.write_text(
                "import decimal\n\n"
                "def test_clean_interpreter():\n"
                "    assert decimal.Decimal('1.5') * 2 == 3\n",
                encoding="utf-8",
            )
            with patch.dict(
                "os.environ",
                {"PYTHONHOME": temporary_directory, "PYTHONPATH": temporary_directory},
            ):
                result = self.toolbelt.run_pytest(
                    test_file,
                    extra_args=("-q", "-p", "no:cacheprovider"),
                    cwd=temporary_directory,
                    timeout_seconds=60,
                )

        self.assertTrue(result.successful, result.stdout + result.stderr)
        self.assertIn("1 passed", result.stdout)

    def test_project_runner_requires_pyproject_and_lockfile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            project_root = Path(temporary_directory)
            with self.assertRaisesRegex(RuntimeError, "reproducible boundary"):
                self.toolbelt.run_project_pytest(project_root, "test_probe.py")

    def test_project_runner_rejects_a_stale_lockfile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            project_root = Path(temporary_directory)
            (project_root / "pyproject.toml").write_text(
                "[project]\n"
                "name = 'stale-project'\n"
                "version = '0.0.0'\n"
                "requires-python = '>=3.11,<3.12'\n"
                "dependencies = []\n",
                encoding="utf-8",
            )
            (project_root / "uv.lock").write_bytes(
                (subject.TOOLBELT_ROOT / "uv.lock").read_bytes()
            )

            with self.assertRaisesRegex(RuntimeError, "stale uv lock"):
                self.toolbelt.run_project_pytest(project_root, "test_probe.py")


if __name__ == "__main__":
    unittest.main()
