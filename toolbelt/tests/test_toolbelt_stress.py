from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings
from concurrent.futures import ThreadPoolExecutor
from io import StringIO
from pathlib import Path
from typing import ClassVar

from dulwich.objects import Commit
from bayma_toolbelt import PythonToolbelt, open_toolbelt
from test_toolbelt import make_committed_repository

PARSE_ITERATIONS = 250
FILE_COUNT = 160
SUBPROCESS_TIMEOUT_SECONDS = 30


class PythonToolbeltStressTest(unittest.TestCase):
    repo_root: ClassVar[Path]
    toolbelt: ClassVar[PythonToolbelt]

    @classmethod
    def setUpClass(cls) -> None:
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        repo_root = make_committed_repository(Path(directory.name).resolve())
        state = open_toolbelt(cwd=repo_root)
        assert state["repo_root"] is not None
        cls.repo_root = state["repo_root"]
        cls.toolbelt = state["toolbelt"]
        assert cls.toolbelt.dulwich_repo is not None
        cls.addClassCleanup(cls.toolbelt.dulwich_repo.close)

    def test_structural_and_semantic_python_pipeline(self) -> None:
        source = "def transform(value: int) -> int:\n    return value + 1\n"
        ast_matches = 0
        for _ in range(PARSE_ITERATIONS):
            root = self.toolbelt.ast_grep.SgRoot(source, "python")
            if root.root().find(pattern="value + 1") is not None:
                ast_matches += 1
            self.assertEqual(self.toolbelt.libcst.parse_module(source).code, source)

        completions = self.toolbelt.jedi.Script(
            "import pathlib\npathlib.Pa", path="probe.py"
        ).complete(2, 10)

        self.assertEqual(ast_matches, PARSE_ITERATIONS)
        self.assertIn("Path", {completion.name for completion in completions})

    def test_structured_document_round_trips(self) -> None:
        markdown = self.toolbelt.markdown_it.MarkdownIt()
        for index in range(PARSE_ITERATIONS):
            self.assertEqual(
                self.toolbelt.json5.loads(
                    f"{{index: {index}, values: [1, 2,],}}"
                )["index"],
                index,
            )
            self.assertIn("<h1>", markdown.render(f"# Item {index}"))

        yaml = self.toolbelt.ruamel_yaml.YAML()
        yaml_document = yaml.load("# retained\nanswer: 42\n")
        yaml_document["answer"] = 43
        yaml_output = StringIO()
        yaml.dump(yaml_document, yaml_output)

        toml_document = self.toolbelt.tomlkit.parse("# retained\nanswer = 42\n")
        toml_document["answer"] = 43

        self.assertIn("# retained", yaml_output.getvalue())
        self.assertIn("# retained", self.toolbelt.tomlkit.dumps(toml_document))

    def test_filesystem_search_matching_and_editor_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            (root / ".editorconfig").write_text(
                "root = true\n\n[*]\nindent_style = space\nindent_size = 2\n",
                encoding="utf-8",
            )
            for index in range(FILE_COUNT):
                suffix = ".py" if index % 2 == 0 else ".txt"
                (root / f"file-{index:03d}{suffix}").write_text(
                    f"record {index} needle-{index % 7}\n", encoding="utf-8"
                )
            binary = root / "binary.bin"
            binary.write_bytes(bytes(range(256)) * 32)

            specification = self.toolbelt.pathspec.PathSpec.from_lines(
                "gitignore", ["*.txt", "binary.bin"]
            )
            ignored = sum(
                specification.match_file(path.name) for path in root.iterdir()
            )
            python_matches = sum(
                self.toolbelt.wcmatch.glob.globmatch(
                    path.name, "*.py", flags=self.toolbelt.wcmatch.glob.GLOBSTAR
                )
                for path in root.iterdir()
            )
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    message=r"codecs\.open\(\) is deprecated",
                    category=DeprecationWarning,
                    module=r"editorconfig\.ini",
                )
                properties = self.toolbelt.editorconfig.get_properties(
                    str(root / "file-000.py")
                )
            search = subprocess.run(
                [str(self.toolbelt.ripgrep), "--count", "needle", str(root)],
                text=True,
                capture_output=True,
                timeout=SUBPROCESS_TIMEOUT_SECONDS,
                check=True,
            )

            self.assertEqual(ignored, FILE_COUNT // 2 + 1)
            self.assertEqual(python_matches, FILE_COUNT // 2)
            self.assertEqual(properties["indent_size"], "2")
            self.assertFalse(
                self.toolbelt.binaryornot.check.is_binary(str(root / "file-000.py"))
            )
            self.assertTrue(self.toolbelt.binaryornot.check.is_binary(str(binary)))
            self.assertEqual(len(search.stdout.splitlines()), FILE_COUNT)

    def test_dulwich_introspection_cache_and_iteration_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo_root = Path(temporary_directory).resolve()
            self.toolbelt.dulwich.porcelain.init(repo_root)
            tracked = repo_root / "history.txt"
            commit_ids = []
            for index in range(24):
                tracked.write_text(f"revision {index}\n", encoding="utf-8")
                self.toolbelt.dulwich.porcelain.add(
                    repo_root, paths=[tracked.name]
                )
                commit_ids.append(
                    self.toolbelt.dulwich.porcelain.commit(
                        repo_root,
                        message=f"revision {index}".encode(),
                        author=b"Toolbelt Test <toolbelt@example.test>",
                        committer=b"Toolbelt Test <toolbelt@example.test>",
                    )
                )

            repository = self.toolbelt.dulwich.repo.Repo(repo_root)
            self.addCleanup(repository.close)
            cache = self.toolbelt.cachetools.LRUCache(maxsize=8)
            for commit_id in commit_ids:
                cache[commit_id] = repository[commit_id].message

            chunks = list(self.toolbelt.more_itertools.chunked(range(10_000), 128))

            self.assertEqual(repository.head(), commit_ids[-1])
            self.assertEqual(len(cache), 8)
            self.assertEqual(len(chunks), 79)
            self.assertEqual(sum(map(len, chunks)), 10_000)

    def test_bound_dulwich_repo_handles_bounded_checkout_reads(self) -> None:
        repository = self.toolbelt.dulwich_repo
        assert repository is not None
        status = self.toolbelt.dulwich.porcelain.status(repository)
        recent = list(repository.get_walker(max_entries=32))
        head = repository[repository.head()]
        index = repository.open_index()

        self.assertIsInstance(head, Commit)
        assert isinstance(head, Commit)
        self.assertEqual(Path(repository.path).resolve(), self.repo_root)
        self.assertTrue(hasattr(status, "unstaged"))
        self.assertTrue(recent)
        self.assertLessEqual(len(recent), 32)
        self.assertEqual(recent[0].commit.id, head.id)
        self.assertIn(head.tree, repository.object_store)
        self.assertGreater(len(index), 0)

    def test_griffe_packaging_and_type_checker_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            module = root / "generated_module.py"
            module.write_text(
                "\n".join(
                    f"def function_{index}(value: int) -> int:\n"
                    f"    return value + {index}\n"
                    for index in range(120)
                ),
                encoding="utf-8",
            )
            loaded = self.toolbelt.griffe.load(
                "generated_module", search_paths=[root]
            )
            type_check = subprocess.run(
                [str(self.toolbelt.basedpyright), "--outputjson", str(module)],
                text=True,
                capture_output=True,
                timeout=SUBPROCESS_TIMEOUT_SECONDS,
                check=False,
            )
            payload = json.loads(type_check.stdout)

            self.assertEqual(len(loaded.functions), 120)
            self.assertIn(
                self.toolbelt.packaging.version.Version("3.12"),
                self.toolbelt.packaging.specifiers.SpecifierSet(">=3.12,<3.13"),
            )
            self.assertEqual(type_check.returncode, 0)
            self.assertEqual(payload["summary"]["errorCount"], 0)

    def test_language_server_and_native_file_watcher(self) -> None:
        server = self.toolbelt.pygls.lsp.server.LanguageServer(
            "toolbelt-stress", "1"
        )
        self.assertEqual((server.name, server.version), ("toolbelt-stress", "1"))

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()

            def create_file() -> None:
                time.sleep(0.15)
                (root / "created.py").write_text("value = 1\n", encoding="utf-8")

            writer = threading.Thread(target=create_file)
            writer.start()
            watcher = self.toolbelt.watchfiles.watch(
                root,
                debounce=50,
                step=10,
                rust_timeout=100,
                yield_on_timeout=True,
            )
            # Platforms batch and order events differently (macOS may first
            # report the watched directory itself), so collect until the
            # file's own event arrives.
            expected = (self.toolbelt.watchfiles.Change.added, str(root / "created.py"))
            observed = set()
            deadline = time.monotonic() + 5
            while expected not in observed and time.monotonic() < deadline:
                observed |= next(watcher)
            watcher.close()
            writer.join(timeout=2)

            self.assertFalse(writer.is_alive())
            self.assertIn(expected, observed)

    def test_isolated_pytest_handles_async_fixtures_selection_and_edits(self) -> None:
        original_cwd = Path.cwd()
        original_path = tuple(sys.path)
        original_environment = os.environ.copy()
        with tempfile.TemporaryDirectory(
            prefix="toolbelt pytest "
        ) as temporary_directory:
            root = Path(temporary_directory).resolve()
            test_file = root / "test behavior.py"
            test_file.write_text(
                "import os\n"
                "import pytest\n\n"
                "def test_sync(monkeypatch, tmp_path):\n"
                "    monkeypatch.setenv('TOOLBELT_PROBE', 'ready')\n"
                "    assert os.environ['TOOLBELT_PROBE'] == 'ready'\n"
                "    assert tmp_path.is_dir()\n\n"
                "@pytest.mark.asyncio\n"
                "async def test_async():\n"
                "    assert True\n\n"
                "def test_selected():\n"
                "    assert 1 == 1\n\n"
                "def test_skipped():\n"
                "    pytest.skip('intentional')\n",
                encoding="utf-8",
            )

            initial = self.toolbelt.run_pytest(
                test_file,
                extra_args=("-q",),
                cwd=root,
                timeout_seconds=30,
            )
            selected = self.toolbelt.run_pytest(
                test_file,
                extra_args=("-q", "-k", "selected"),
                cwd=root,
                timeout_seconds=30,
            )
            test_file.write_text(
                "def test_selected():\n    assert 1 == 2\n",
                encoding="utf-8",
            )
            edited = self.toolbelt.run_pytest(
                test_file,
                extra_args=("-q",),
                cwd=root,
                timeout_seconds=30,
            )

        self.assertTrue(initial.successful, initial.stderr)
        self.assertIn("3 passed", initial.stdout)
        self.assertIn("1 skipped", initial.stdout)
        self.assertTrue(selected.successful, selected.stderr)
        self.assertIn("1 passed", selected.stdout)
        self.assertEqual(edited.returncode, 1)
        self.assertIn("1 failed", edited.stdout)
        self.assertEqual(Path.cwd(), original_cwd)
        self.assertEqual(tuple(sys.path), original_path)
        self.assertEqual(os.environ, original_environment)

    def test_pytest_reports_collection_errors_bounds_output_and_times_out(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            broken = root / "test_broken.py"
            broken.write_text("def test_broken(:\n    pass\n", encoding="utf-8")
            collection = self.toolbelt.run_pytest(
                broken,
                extra_args=("-q",),
                cwd=root,
                timeout_seconds=30,
            )

            noisy = root / "test_noisy.py"
            noisy.write_text(
                "def test_noisy():\n"
                "    print('x' * 20000)\n"
                "    assert True\n",
                encoding="utf-8",
            )
            bounded = self.toolbelt.run_pytest(
                noisy,
                extra_args=("-q", "-s"),
                cwd=root,
                timeout_seconds=30,
                output_limit_bytes=2048,
            )

            sleeping = root / "test_sleeping.py"
            sleeping.write_text(
                "import time\n\n"
                "def test_sleeping():\n"
                "    time.sleep(5)\n",
                encoding="utf-8",
            )
            timed_out = self.toolbelt.run_pytest(
                sleeping,
                extra_args=("-q",),
                cwd=root,
                timeout_seconds=0.25,
            )

        self.assertEqual(collection.returncode, 2)
        self.assertIn("1 error", collection.stdout)
        self.assertTrue(bounded.successful)
        self.assertIn("output bytes omitted", bounded.stdout)
        self.assertTrue(timed_out.timed_out)
        self.assertFalse(timed_out.successful)

    def test_parallel_pytest_processes_remain_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            test_files = []
            for index in range(4):
                test_file = root / f"test_parallel_{index}.py"
                test_file.write_text(
                    f"def test_parallel_{index}():\n    assert {index} >= 0\n",
                    encoding="utf-8",
                )
                test_files.append(test_file)

            with ThreadPoolExecutor(max_workers=4) as executor:
                results = list(
                    executor.map(
                        lambda path: self.toolbelt.run_pytest(
                            path,
                            extra_args=("-q",),
                            cwd=root,
                            timeout_seconds=30,
                        ),
                        test_files,
                    )
                )

        self.assertTrue(all(result.successful for result in results))
        self.assertTrue(all("1 passed" in result.stdout for result in results))

    def test_ruff_checks_a_bounded_batch_and_returns_json_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="toolbelt ruff "
        ) as temporary_directory:
            root = Path(temporary_directory).resolve()
            for index in range(200):
                (root / f"module_{index:03d}.py").write_text(
                    f"value_{index} = {index}\n", encoding="utf-8"
                )
            invalid = root / "invalid module.py"
            invalid.write_text("import os\n\nvalue = missing\n", encoding="utf-8")

            diagnosed = self.toolbelt.run_ruff(
                root,
                extra_args=(
                    "--output-format",
                    "json",
                    "--select",
                    "E4,E7,E9,F",
                ),
                cwd=root,
                timeout_seconds=30,
            )
            diagnostics = json.loads(diagnosed.stdout)
            invalid.write_text("value = 1\n", encoding="utf-8")
            clean = self.toolbelt.run_ruff(
                root,
                extra_args=("--select", "E4,E7,E9,F"),
                cwd=root,
                timeout_seconds=30,
            )

        self.assertEqual(diagnosed.returncode, 1)
        self.assertEqual({item["code"] for item in diagnostics}, {"F401", "F821"})
        self.assertTrue(clean.successful, clean.stdout + clean.stderr)

    def test_project_owned_uv_runners_use_the_locked_boundary(self) -> None:
        toolbelt_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            test_file = root / "test_project_runner.py"
            test_file.write_text(
                "def test_project_runner():\n    assert True\n", encoding="utf-8"
            )
            source_file = root / "project_runner.py"
            source_file.write_text("value = 1\n", encoding="utf-8")

            pytest_result = self.toolbelt.run_project_pytest(
                toolbelt_root,
                test_file,
                extra_args=("-q",),
                timeout_seconds=60,
            )
            ruff_result = self.toolbelt.run_project_ruff(
                toolbelt_root,
                source_file,
                extra_args=("--select", "E4,E7,E9,F"),
                timeout_seconds=60,
            )

        self.assertTrue(pytest_result.successful, pytest_result.stderr)
        self.assertTrue(ruff_result.successful, ruff_result.stderr)
        for result in (pytest_result, ruff_result):
            self.assertIn("uv", Path(result.argv[0]).name)
            self.assertIn("--frozen", result.argv)
            self.assertEqual(result.cwd, toolbelt_root)


if __name__ == "__main__":
    unittest.main()
