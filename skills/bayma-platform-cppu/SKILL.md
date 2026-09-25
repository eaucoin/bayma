---
name: bayma-platform-cppu
description: Inspect the headers of and execute C++ against LibreOffice's UNO API, with a headless LibreOffice kept in this skill's folder; create, edit, convert, and export Writer, Calc, Impress, and Draw documents.
---

# LibreOffice UNO Platform

This skill shows you where to find the relevant headers and API reference to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns LibreOffice, the official release with its SDK, in its own folder, `<skill>` below. Code runs in a bayma C++ session, which drives a headless LibreOffice over UNO.

## Reference Materials

- `<skill>/libreoffice/include/com/sun/star/**/*.hpp`: the office API, a header for each type: services, interfaces, structs, enums, and constant groups, such as `text/XTextDocument.hpp`
- `<skill>/libreoffice/sdk/docs/idl/ref/*_8idl_source.html`: each type's IDL, with its documentation
- `<skill>/libreoffice/sdk/include/{sal,rtl,osl,cppu,cppuhelper}/**`: the C++ UNO runtime: `Reference`, `Any`, `Sequence`, and `OUString`
- `<skill>/libreoffice/sdk/examples/{cpp,DevelopersGuide}/**`: LibreOffice's own examples
- https://api.libreoffice.org/: the API reference
- `<skill>/office.h`: the office, started headless and connected

If these materials are missing, install LibreOffice, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install.ts 2>&1`.nothrow().text();
```

## Interactive Quickstart

In a bayma C++ session whose `cwd` is `<skill>`, where the `compile_flags.txt` the install wrote gives it the API's headers and loads the UNO runtime:

```cpp
#include "office.h"
#include <com/sun/star/beans/PropertyValue.hpp>
#include <com/sun/star/frame/XComponentLoader.hpp>
#include <com/sun/star/text/XTextDocument.hpp>

namespace css = com::sun::star;
css::uno::Sequence<css::beans::PropertyValue> hidden(1);
hidden.getArray()[0].Name = "Hidden";
hidden.getArray()[0].Value <<= true;
css::uno::Reference<css::frame::XComponentLoader> officeLoader(
    bayma_office::desktop(), css::uno::UNO_QUERY_THROW);
css::uno::Reference<css::text::XTextDocument> writerDocument(
    officeLoader->loadComponentFromURL("private:factory/swriter", "_blank", 0, hidden),
    css::uno::UNO_QUERY_THROW);
writerDocument->getText()->setString("Written over UNO");
std::string(OUStringToOString(writerDocument->getText()->getString(),
                              RTL_TEXTENCODING_UTF8).getStr())
```

`bayma_office::connect()` starts LibreOffice the first time, on a profile in `<skill>/profile`, and connects over a pipe; later calls, and later sessions, reuse that office until `bayma_office::terminate()` ends it. `private:factory/swriter`, `scalc`, `simpress`, or `sdraw` creates a document, and `XStorable::storeToURL` exports it through a filter, such as `MS Word 2007 XML`, `Calc MS Excel 2007 XML`, `Impress MS PowerPoint 2007 XML`, or `writer_pdf_Export`. The SDK's headers give `Sequence` no initializer-list constructor, and convert no `Reference` to one of its interface's bases; build each explicitly. A text range grows with text inserted at its end, so act on a range before writing past it.
