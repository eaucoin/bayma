---
name: bayma-platform-ooxml
description: Inspect the API documentation of and execute code from the Open XML SDK, the `DocumentFormat.OpenXml` .NET library, kept in this skill's folder; create, read, edit, and validate Excel, Word, and PowerPoint files.
---

# OOXML Platform

This skill shows you where to find the relevant packages to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns its packages; they live in its own folder, `<skill>` below. Code runs in a bayma C# session, against the Open XML SDK itself.

## Reference Materials

- `<skill>/lib/DocumentFormat.OpenXml.xml`: the documents and their parts (`DocumentFormat.OpenXml.Packaging`), and one class per element of the standard: `Spreadsheet`, `Wordprocessing`, `Presentation`, and DrawingML's `Drawing`, `Drawing.Charts`, and `Drawing.Spreadsheet`
- `<skill>/lib/DocumentFormat.OpenXml.Framework.xml`: what those classes build on: `OpenXmlElement`, `OpenXmlPackage`, and `OpenXmlValidator`
- https://learn.microsoft.com/office/open-xml/open-xml-sdk: the SDK's guides, a how-to for each common task
- https://ecma-international.org/publications-and-standards/standards/ecma-376/: ECMA-376, the Office Open XML standard the classes follow

If these materials are missing, restore them from the skill's lockfile, in a bayma C# session whose `cwd` is `<skill>`:

```csharp
var restore = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("dotnet", "build -c Release -o lib -p:RestoreLockedMode=true") { RedirectStandardOutput = true });
var restoreOutput = restore.StandardOutput.ReadToEnd();
restore.WaitForExit();
restoreOutput
```

## Interactive Quickstart

In a bayma C# session, reference the SDK's assemblies in the cell that first succeeds with them, since a cell that fails is rolled back with its references, and spell `<skill>` out as an absolute path, since `#r` does not resolve paths from the session's `cwd`:

```csharp
#r "<skill>/lib/System.IO.Packaging.dll"
#r "<skill>/lib/DocumentFormat.OpenXml.Framework.dll"
#r "<skill>/lib/DocumentFormat.OpenXml.dll"
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

typeof(OpenXmlElement).Assembly.GetName().Version.ToString()
```

`SpreadsheetDocument`, `WordprocessingDocument`, and `PresentationDocument` create and open files, and each part, such as a `WorksheetPart`, holds a tree of typed elements, in the order the standard gives them. `new OpenXmlValidator(FileFormatVersions.Microsoft365).Validate(document)` checks a document against the standard; Office expects more than the schema does: a table's header cells spelling its column names, a note's shape in a `VmlDrawingPart`, and a threaded comment's author in a `WorkbookPersonPart`, with a legacy comment for older versions. Give each formula its cached value, or set `FullCalculationOnLoad` in the workbook's `CalculationProperties`, so viewers that do not recalculate show values.
