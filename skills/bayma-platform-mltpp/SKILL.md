---
name: bayma-platform-mltpp
description: Inspect the headers of and execute code against MLT++, the C++ API of the MLT multimedia framework, kept with its libraries in this skill's folder; edit, filter, and render audio and video.
---

# MLT++ Platform

This skill shows you where to find the relevant headers and service descriptions to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns MLT: its headers, libraries, modules, and data live in its own folder, `<skill>` below.

## Reference Materials

- `<skill>/mlt/include/mlt++/*.h`: MLT++
- `<skill>/mlt/include/framework/*.h`: the C framework under it
- `<skill>/mlt/data/<module>/<type>_<service>.yml`: each producer, filter, transition, and consumer, with its parameters
- `<skill>/mlt/data/presets/consumer/avformat/**`: encoding presets

If these materials are missing, install MLT, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install.ts 2>&1`.nothrow().text();
```

## Interactive Quickstart

In a bayma C++ session whose `cwd` is `<skill>`, first load MLT's libraries. A cell is linked before it runs, so code using MLT++ goes in the cells after this one:

```cpp
#include <dlfcn.h>
#include <fstream>
#include <string>

std::string mltStatus = "loaded";
{
  std::ifstream libraries("mlt/libraries.txt");
  if (!libraries)
    mltStatus = "MLT is not installed; install it as above";
  for (std::string name; mltStatus == "loaded" && std::getline(libraries, name);)
    if (!dlopen(("mlt/lib/" + name).c_str(), RTLD_NOW | RTLD_GLOBAL))
      mltStatus = dlerror();
}
mltStatus
```

Then:

```cpp
#include <cstdlib>
#include <filesystem>
#include "mlt/include/mlt++/Mlt.h"

setenv("MLT_DATA", std::filesystem::absolute("mlt/data").c_str(), 1);
Mlt::Repository *mltRepository =
    Mlt::Factory::init(std::filesystem::absolute("mlt/modules").c_str());
Mlt::Profile mltProfile;
std::format("MLT {}: {} producers, {} filters, {} consumers",
            mlt_version_get_string(), mltRepository->producers()->count(),
            mltRepository->filters()->count(),
            mltRepository->consumers()->count())
```

Open media with `Mlt::Producer(mltProfile, path)`, which adds the filters that normalize it, rather than by naming a producer such as `avformat`: an `avformat` consumer waits forever for audio an unnormalized producer does not give it.
