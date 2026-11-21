(() => {
  "use strict";

  // Comparison key for labels and names: width, case and spacing do not matter.
  const normalize = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();

  globalThis.TextKey = Object.freeze({ normalize });
})();
