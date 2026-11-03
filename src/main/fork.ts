/**
 * Switches of Elias's fork (eliasx45/openbot). See docs/fork/FEATURES.md.
 *
 * Upstream code stays as it is; it reads these switches, so a merge from `upstream/main` stays small.
 */

/**
 * Off: the app never checks for, downloads or installs an OpenBot release. A release would replace
 * the fork's build (and every fork change) with upstream's.
 */
export const updatesAllowed = false;
