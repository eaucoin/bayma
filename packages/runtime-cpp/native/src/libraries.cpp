#include "libraries.h"

#include "llvm/ADT/StringSet.h"
#include "llvm/BinaryFormat/ELF.h"
#include "llvm/Object/ELF.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/Path.h"

#include <cstring>
#include <dlfcn.h>
#include <optional>
#include <string>
#include <vector>

namespace bayma {

namespace {

#ifdef __APPLE__
constexpr llvm::StringLiteral SharedLibrarySuffix = ".dylib";
#else
constexpr llvm::StringLiteral SharedLibrarySuffix = ".so";
#endif

std::string absolute(llvm::StringRef Path, llvm::StringRef Cwd) {
  llvm::SmallString<256> Absolute(Path);
  llvm::sys::path::make_absolute(Cwd, Absolute);
  llvm::sys::path::remove_dots(Absolute, /*remove_dot_dot=*/true);
  return Absolute.str().str();
}

/// `File` in the first of `Directories` that holds it.
std::optional<std::string> find(llvm::StringRef File,
                                llvm::ArrayRef<std::string> Directories) {
  for (const std::string &Directory : Directories) {
    llvm::SmallString<256> Path(Directory);
    llvm::sys::path::append(Path, File);
    if (llvm::sys::fs::is_regular_file(Path))
      return Path.str().str();
  }
  return std::nullopt;
}

/// The libraries an ELF shared library names as needed; none for anything
/// else, which the dynamic linker resolves on its own.
std::vector<std::string> neededLibraries(llvm::StringRef Path) {
  std::vector<std::string> Needed;
  auto Buffer = llvm::MemoryBuffer::getFile(Path);
  if (!Buffer)
    return Needed;
  llvm::StringRef Data = (*Buffer)->getBuffer();
  auto File = llvm::object::ELF64LEFile::create(Data);
  if (!File) {
    llvm::consumeError(File.takeError());
    return Needed;
  }
  auto Entries = File->dynamicEntries();
  if (!Entries) {
    llvm::consumeError(Entries.takeError());
    return Needed;
  }
  uint64_t StringTable = 0;
  std::vector<uint64_t> Offsets;
  for (const auto &Entry : *Entries) {
    if (Entry.d_tag == llvm::ELF::DT_STRTAB)
      StringTable = Entry.getPtr();
    else if (Entry.d_tag == llvm::ELF::DT_NEEDED)
      Offsets.push_back(Entry.getVal());
  }
  auto Strings = File->toMappedAddr(StringTable);
  if (!Strings) {
    llvm::consumeError(Strings.takeError());
    return Needed;
  }
  const char *End = Data.end();
  for (uint64_t Offset : Offsets) {
    const char *Name = reinterpret_cast<const char *>(*Strings) + Offset;
    if (Name < End)
      Needed.emplace_back(Name, ::strnlen(Name, End - Name));
  }
  return Needed;
}

class Loader {
public:
  Loader(const SessionSettings &Settings, llvm::StringRef Cwd) : Cwd(Cwd) {
    for (const std::string &Directory : Settings.LibraryDirectories)
      Directories.push_back(absolute(Directory, Cwd));
  }

  /// A `-l` name or a path, resolved to the library to load.
  std::string resolve(llvm::StringRef Library) {
    if (!Library.consume_front("-l"))
      return absolute(Library, Cwd);
    std::string File = Library.consume_front(":")
                           ? Library.str()
                           : ("lib" + Library + SharedLibrarySuffix).str();
    if (auto Found = find(File, Directories))
      return *Found;
    // Not in the settings' directories: the dynamic linker's to find.
    return File;
  }

  /// Loads `Path` after what it needs that is not yet loaded and the
  /// settings' directories or its own directory hold. A bare file name is
  /// the dynamic linker's to find, with what it needs.
  llvm::Error load(const std::string &Path) {
    if (!Visited.insert(Path).second)
      return llvm::Error::success();
    if (llvm::sys::path::has_parent_path(Path))
      if (llvm::Error Err = loadNeeded(Path))
        return Err;
    if (!::dlopen(Path.c_str(), RTLD_NOW | RTLD_GLOBAL))
      return llvm::createStringError(::dlerror());
    return llvm::Error::success();
  }

private:
  llvm::Error loadNeeded(const std::string &Path) {
    std::vector<std::string> Searched = Directories;
    Searched.push_back(llvm::sys::path::parent_path(Path).str());
    for (const std::string &Needed : neededLibraries(Path)) {
      if (void *Loaded = ::dlopen(Needed.c_str(), RTLD_NOW | RTLD_NOLOAD)) {
        ::dlclose(Loaded);
        continue;
      }
      if (auto Found = find(Needed, Searched))
        if (llvm::Error Err = load(*Found))
          return Err;
    }
    return llvm::Error::success();
  }

  std::string Cwd;
  std::vector<std::string> Directories;
  llvm::StringSet<> Visited;
};

} // namespace

llvm::Error loadLibraries(const SessionSettings &Settings,
                          llvm::StringRef Cwd) {
  Loader L(Settings, Cwd);
  for (const std::string &Library : Settings.Libraries) {
    if (llvm::Error Err = L.load(L.resolve(Library)))
      return llvm::createStringError("compile_flags.txt: cannot load " +
                                     Library + ": " +
                                     llvm::toString(std::move(Err)));
  }
  return llvm::Error::success();
}

} // namespace bayma
