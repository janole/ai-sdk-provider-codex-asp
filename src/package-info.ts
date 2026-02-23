import pkg from "../package.json" with { type: "json" };

/** Package name from package.json. */
export const PACKAGE_NAME: string = pkg.name;

/** Package version from package.json. */
export const PACKAGE_VERSION: string = pkg.version;
