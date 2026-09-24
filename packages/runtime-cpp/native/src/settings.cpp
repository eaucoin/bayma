#include "settings.h"

#include "llvm/ADT/SmallString.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/Path.h"

namespace bayma {

namespace {

bool isSharedLibrary(llvm::StringRef Arg) {
  return !Arg.starts_with("-") &&
         (Arg.ends_with(".so") || Arg.contains(".so.") ||
          Arg.ends_with(".dylib"));
}

} // namespace

llvm::Expected<SessionSettings> readSettings(llvm::StringRef Cwd,
                                             Language Lang) {
  SessionSettings Settings;
  llvm::SmallString<256> Path(Cwd);
  llvm::sys::path::append(Path, "compile_flags.txt");
  auto Buffer = llvm::MemoryBuffer::getFile(Path, /*IsText=*/true);
  if (!Buffer) {
    if (Buffer.getError() == std::errc::no_such_file_or_directory)
      return Settings;
    return llvm::createStringError(Buffer.getError(), "cannot read " + Path);
  }

  llvm::SmallVector<llvm::StringRef> Lines;
  (*Buffer)->getBuffer().split(Lines, '\n');
  std::vector<llvm::StringRef> Args;
  for (llvm::StringRef Line : Lines)
    if (llvm::StringRef Arg = Line.trim(); !Arg.empty())
      Args.push_back(Arg);

  bool Cxx = Lang == Language::Cxx;
  for (std::size_t Index = 0; Index < Args.size(); ++Index) {
    llvm::StringRef Arg = Args[Index];
    // A flag given its value on the next line, as clangd allows.
    auto Value = [&](llvm::StringRef Flag) -> llvm::Expected<llvm::StringRef> {
      if (Arg != Flag)
        return Arg.drop_front(Flag.size());
      if (Index + 1 == Args.size())
        return llvm::createStringError(Path + ": " + Flag +
                                       " is missing its value");
      return Args[++Index];
    };
    if (Arg.starts_with("-L")) {
      auto Directory = Value("-L");
      if (!Directory)
        return Directory.takeError();
      Settings.LibraryDirectories.push_back(Directory->str());
    } else if (Arg.starts_with("-l")) {
      auto Name = Value("-l");
      if (!Name)
        return Name.takeError();
      Settings.Libraries.push_back(("-l" + *Name).str());
    } else if (isSharedLibrary(Arg)) {
      Settings.Libraries.push_back(Arg.str());
    } else if (Arg.consume_front("-stdlib=")) {
      if (!Cxx)
        continue;
      if (Arg == "libstdc++")
        Settings.Stdlib = StandardLibrary::Libstdcxx;
      else if (Arg != "libc++")
        return llvm::createStringError(
            Path + ": -stdlib= must be libc++ or libstdc++, not " + Arg);
      Settings.CompilerArgs.push_back(("-stdlib=" + Arg).str());
    } else if (Arg.starts_with("-std=")) {
      if (Arg.contains("++") == Cxx)
        Settings.CompilerArgs.push_back(Arg.str());
    } else {
      Settings.CompilerArgs.push_back(Arg.str());
    }
  }
#ifndef __linux__
  if (Settings.Stdlib == StandardLibrary::Libstdcxx)
    return llvm::createStringError(Path +
                                   ": -stdlib=libstdc++ is for Linux only");
#endif
  return Settings;
}

} // namespace bayma
