"""Build a platform-specific fastsite wheel containing compiled extensions only."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
PACKAGE = SRC / "fastsite"
DIST = ROOT / "dist-secure"
KEEP_PY = {"__init__.py", "cli.py", "connectors/__init__.py"}


def _extension_suffixes() -> tuple[str, ...]:
    from importlib.machinery import EXTENSION_SUFFIXES

    return tuple(EXTENSION_SUFFIXES)


def _sources() -> list[Path]:
    return sorted(path for path in PACKAGE.rglob("*.py") if path.relative_to(PACKAGE).as_posix() not in KEEP_PY)


def _write_compile_setup(target: Path) -> None:
    sources = [str(path.relative_to(SRC)).replace("\\", "/") for path in _sources()]
    sources.append("fastsite/_compiled_config.pyx")
    modules = [source.rsplit(".", 1)[0].replace("/", ".") for source in sources]
    lines = [
        "from setuptools import Extension, setup",
        "from Cython.Build import cythonize",
        "",
        "extensions = [",
    ]
    lines.extend(f"    Extension({module!r}, [{source!r}])," for module, source in zip(modules, sources))
    lines.extend([
        "]",
        "setup(",
        "    ext_modules=cythonize(extensions, compiler_directives={'language_level': '3'}, force=True),",
        "    script_args=['build_ext', '--inplace', '--force'],",
        ")",
    ])
    target.write_text("\n".join(lines), encoding="utf-8")


def _compile() -> None:
    setup_path = ROOT / "_secure_cython_setup.py"
    try:
        _write_compile_setup(setup_path)
        subprocess.run([sys.executable, str(setup_path)], cwd=SRC, check=True)
    finally:
        setup_path.unlink(missing_ok=True)
        shutil.rmtree(SRC / "build", ignore_errors=True)


def _copy_secure_package(stage_root: Path) -> None:
    package_target = stage_root / "fastsite"
    for source in PACKAGE.rglob("*.py"):
        relative = source.relative_to(PACKAGE).as_posix()
        if relative in KEEP_PY:
            target = package_target / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    suffixes = _extension_suffixes()
    for source in PACKAGE.rglob("*"):
        if source.is_file() and source.name.endswith(suffixes):
            target = package_target / source.relative_to(PACKAGE)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def _write_wheel_setup(stage_root: Path) -> None:
    (stage_root / "setup.py").write_text(
        """from setuptools import find_packages, setup
from setuptools.dist import Distribution
from wheel.bdist_wheel import bdist_wheel


class BinaryWheel(bdist_wheel):
    def finalize_options(self):
        super().finalize_options()
        self.root_is_pure = False


class BinaryDistribution(Distribution):
    def has_ext_modules(self):
        return True

setup(
    name='fastsite',
    version='0.2.1',
    description='Compiled fastsite host with embedded encrypted database configuration',
    python_requires='>=3.11',
    install_requires=['APScheduler>=3.10,<4', 'fastapi>=0.115,<1', 'DBUtils>=3.1,<4', 'pymysql>=1.1,<2', 'cryptography>=41,<45', 'jinja2>=3.1,<4'],
    packages=find_packages(),
    include_package_data=True,
    package_data={'fastsite': ['*.so', '*.pyd', 'connectors/*.so', 'connectors/*.pyd']},
    cmdclass={'bdist_wheel': BinaryWheel},
    distclass=BinaryDistribution,
    entry_points={'console_scripts': ['fastsite-cli=fastsite.cli:main']},
)
""",
        encoding="utf-8",
    )


def _clean_generated_artifacts() -> None:
    suffixes = _extension_suffixes()
    for path in PACKAGE.rglob("*"):
        if not path.is_file():
            continue
        if path.name == "_compiled_config.pyx" or path.suffix == ".c" or path.name.endswith(suffixes):
            path.unlink()


def build(config_path: Path, output_dir: Path) -> None:
    subprocess.run(
        [sys.executable, str(ROOT / "build_embedded_config.py"), "--config", str(config_path)],
        cwd=ROOT,
        check=True,
    )
    try:
        _compile()
        output_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as temp_dir:
            stage_root = Path(temp_dir)
            _copy_secure_package(stage_root)
            _write_wheel_setup(stage_root)
            subprocess.run(
                [sys.executable, "setup.py", "bdist_wheel", "--dist-dir", str(output_dir.resolve())],
                cwd=stage_root,
                check=True,
            )
    finally:
        _clean_generated_artifacts()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "build-config.yml")
    parser.add_argument("--output-dir", type=Path, default=DIST)
    args = parser.parse_args()
    try:
        build(args.config.resolve(), args.output_dir.resolve())
    except subprocess.CalledProcessError as error:
        print(f"build failed: {error}", file=sys.stderr)
        return error.returncode or 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
