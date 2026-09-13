"""The second-stack instructions must name the variables the local stack reads.

`README.md` tells an operator how to run a second local stack beside a running
one. Every name in that section is one the shell scripts or the compose file
substitute, and each has a default: a name that is merely plausible is not
rejected, it is ignored, and the stack silently starts on the default project and
the default ports it was meant to run beside. That failure is invisible until the
collision, so the agreement is pinned here rather than left to a reader comparing
two files.
"""

from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
README = HERE / "README.md"
SCRIPT = HERE / "local-stack.sh"
BUILD = HERE / "build-images.sh"
COMPOSE = HERE / "compose.local.yaml"

SECOND_STACK_HEADING = "### Running a second stack"
# `${NAME:-default}` in the shell scripts and the compose file.
SUBSTITUTION = re.compile(r"\$\{(PORTAL_LOCAL_[A-Z0-9_]+):-([^}]*)\}")
# `NAME=value` in the README's exports.
DOCUMENTED = re.compile(r"\b(PORTAL_[A-Z0-9_]+)=(\S+)")
PUBLISHED = re.compile(r'"127\.0\.0\.1:\$\{(PORTAL_LOCAL_[A-Z0-9_]+):-(\d+)\}')
PORT_SENTENCE = re.compile(r"The runner publishes ports ([^.]+)\.", re.S)


def substituted(path: Path) -> dict[str, str]:
    """Every `${PORTAL_LOCAL_*:-default}` the file reads, mapped to its default."""
    return dict(SUBSTITUTION.findall(path.read_text()))


def second_stack_block() -> str:
    """The one bash block under the second-stack heading."""
    sections = re.split(r"^(### .+)$", README.read_text(), flags=re.M)
    headings = {sections[index].strip(): sections[index + 1] for index in range(1, len(sections) - 1, 2)}
    if SECOND_STACK_HEADING not in headings:
        raise AssertionError(f"{SECOND_STACK_HEADING!r} is no longer a heading in README.md")
    fences = re.findall(r"```bash\n(.*?)```", headings[SECOND_STACK_HEADING], flags=re.S)
    if len(fences) != 1:
        raise AssertionError(f"expected one bash block under {SECOND_STACK_HEADING!r}, found {len(fences)}")
    return fences[0]


def documented_names() -> set[str]:
    return {name for name, _ in DOCUMENTED.findall(second_stack_block())}


class SecondStackDocumentationTests(unittest.TestCase):
    def test_the_parsers_still_find_something(self):
        """A regex that matches nothing would make every assertion below vacuous."""
        self.assertTrue(substituted(SCRIPT))
        self.assertTrue(substituted(BUILD))
        self.assertTrue(substituted(COMPOSE))
        self.assertTrue(documented_names())

    def test_every_documented_name_is_one_the_stack_reads(self):
        reads = set(substituted(SCRIPT)) | set(substituted(BUILD)) | set(substituted(COMPOSE))
        self.assertEqual(
            documented_names() - reads,
            set(),
            "README.md documents variables nothing substitutes; exporting them starts the default stack",
        )

    def test_every_name_the_stack_reads_is_documented(self):
        reads = set(substituted(SCRIPT)) | set(substituted(COMPOSE))
        self.assertEqual(
            reads - documented_names(),
            set(),
            "the stack reads a variable the second-stack section does not document",
        )

    def test_the_stack_name_prefixes_the_images_the_build_tags(self):
        """One name for the Compose project and the image prefix, as the README says."""
        build = BUILD.read_text()
        self.assertIn("stack=${PORTAL_LOCAL_STACK:-", build)
        self.assertIn("tag=${PORTAL_LOCAL_TAG:-", build)
        images = re.findall(r"^\s*image: (\S+)$", COMPOSE.read_text(), flags=re.M)
        self.assertTrue(images)
        for image in images:
            with self.subTest(image=image):
                # Third-party images (postgres, redis, the emulators) carry no stack prefix.
                if "${" not in image:
                    continue
                self.assertTrue(
                    image.startswith("${PORTAL_LOCAL_STACK:-"),
                    f"{image} is built by build-images.sh but not named from the stack variable",
                )

    def test_the_published_port_list_matches_the_defaults(self):
        defaults = substituted(SCRIPT)
        expected = sorted({int(defaults.get(name, fallback)) for name, fallback in PUBLISHED.findall(COMPOSE.read_text())})
        self.assertTrue(expected)
        sentence = PORT_SENTENCE.search(README.read_text())
        self.assertIsNotNone(sentence, "the published-port sentence was renamed")
        self.assertEqual(sorted(int(port) for port in re.findall(r"\d+", sentence.group(1))), expected)


if __name__ == "__main__":
    unittest.main()
