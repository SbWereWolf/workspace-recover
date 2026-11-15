"""Build installed resources from this standalone repository's authored files."""
from pathlib import Path
import shutil
from setuptools import setup
from setuptools.command.build_py import build_py


class BuildResources(build_py):
    def run(self):
        super().run()
        root = Path(__file__).parent
        target = Path(self.build_lib) / "workspace_recover" / "resources"
        for name in ("templates", "schemas"):
            shutil.copytree(root / name, target / name, dirs_exist_ok=True)


setup(cmdclass={"build_py": BuildResources})
