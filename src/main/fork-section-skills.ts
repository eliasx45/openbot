// Fork (docs/fork/FEATURES.md #108): the local-library skills of a sidebar section, unpacked once per revision.
import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SectionDefaultsChoice } from "@openbot/contracts/fork-section-defaults";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result } from "effect";
import type { SectionSkillFile } from "../backend/fork-section-inheritance";
import type { LocalSkillLibrary } from "./local-skill-library";
import { readSkillArchive } from "./skill-package";

const logger = createOpenBotLogger("fork-section-skills");

const LOCAL_SKILL_ID = /^local-skill-[\da-f-]{36}$/u;

export class ForkSectionSkills {
  readonly #root: string;
  readonly #library: () => LocalSkillLibrary | null;
  readonly #unpacked = new Map<string, SectionSkillFile>();

  constructor(root: string, library: () => LocalSkillLibrary | null) {
    this.#root = root;
    this.#library = library;
  }

  choices(): Effect.Effect<SectionDefaultsChoice[]> {
    const library = this.#library();
    if (!library) return Effect.succeed([]);
    return library.list().pipe(
      Effect.map((skills) =>
        skills.map((skill) => ({
          id: skill.id,
          name: skill.name || skill.slug,
          ...(skill.description ? { description: skill.description } : {}),
        })),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          logger.warn("OpenBot could not list the local skills for section defaults.", { error: String(error.cause) });
          return [];
        }),
      ),
    );
  }

  files(skillIds: readonly string[]): Effect.Effect<SectionSkillFile[]> {
    return Effect.gen({ self: this }, function* () {
      const files: SectionSkillFile[] = [];
      for (const skillId of skillIds) {
        const file = yield* Effect.result(this.#file(skillId));
        if (Result.isSuccess(file)) files.push(file.success);
        else
          logger.warn("OpenBot left out a section skill that it could not read.", {
            skillId,
            error: String(file.failure),
          });
      }
      return files;
    });
  }

  #file(skillId: string): Effect.Effect<SectionSkillFile, unknown> {
    return Effect.gen({ self: this }, function* () {
      const library = this.#library();
      if (!library || !LOCAL_SKILL_ID.test(skillId)) return yield* Effect.fail(new Error("Not a local skill."));
      const revision = Math.max(...(yield* library.revisions(skillId)));
      const key = `${skillId}@${revision}`;
      const known = this.#unpacked.get(key);
      if (known) return known;
      const detail = yield* library.get(skillId, revision);
      const directory = join(this.#root, skillId, String(revision));
      const file = join(directory, "SKILL.md");
      const present = yield* Effect.tryPromise(() => access(file)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!present) {
        const bytes = yield* library.bundle(skillId, revision);
        yield* Effect.tryPromise(() => unpack(bytes, directory));
      }
      const unpacked: SectionSkillFile = {
        id: skillId,
        slug: detail.slug,
        name: detail.name || detail.slug,
        description: detail.description,
        file,
      };
      this.#unpacked.set(key, unpacked);
      return unpacked;
    });
  }
}

async function unpack(bytes: Uint8Array, directory: string): Promise<void> {
  const { files, executable } = readSkillArchive(bytes);
  const staged = `${directory}.${randomUUID()}`;
  try {
    for (const [name, data] of Object.entries(files)) {
      const target = join(staged, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { mode: executable.has(name) ? 0o700 : 0o600 });
    }
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await rename(staged, directory);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    const exists = await access(join(directory, "SKILL.md")).then(
      () => true,
      () => false,
    );
    if (!exists) throw error;
  }
}
