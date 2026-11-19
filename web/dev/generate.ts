import { join } from "node:path";
import { writeCssTypes } from "./css-types.ts";
import { writeSprite } from "./icons.ts";

// What typecheck, test, dev and build need besides the route tree: the icon sprite and the CSS
// module types. All gitignored.
const src = join(import.meta.dir, "../src");
writeSprite(join(src, "ui/icons"));
writeCssTypes(src);
