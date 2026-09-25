// LibreOffice, headless and reached over UNO. bayma_office::connect() returns
// the office's component context: it connects to the office running on the
// skill's profile, or starts one there, listening on a pipe named for the
// profile, so the office outlives the sessions that use it and is shared by
// them. bayma_office::terminate() ends it.
#pragma once

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <functional>
#include <spawn.h>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include <com/sun/star/bridge/UnoUrlResolver.hpp>
#include <com/sun/star/connection/NoConnectException.hpp>
#include <com/sun/star/frame/Desktop.hpp>
#include <com/sun/star/frame/XDesktop2.hpp>
#include <com/sun/star/uno/RuntimeException.hpp>
#include <com/sun/star/uno/XComponentContext.hpp>
#include <cppuhelper/bootstrap.hxx>

extern char **environ;

namespace bayma_office {

namespace css = com::sun::star;

// The office's context, once connected.
inline css::uno::Reference<css::uno::XComponentContext> connected;

inline std::string pipeName() {
  return "bayma_office_" +
         std::to_string(std::hash<std::string>{}(BAYMA_OFFICE_PROFILE));
}

// Starts the office on the profile, listening on pipeName(). It writes what
// it says to profile.log, beside the profile.
inline void start() {
  const std::string binary =
      std::string(BAYMA_OFFICE_ROOT) + "/program/soffice.bin";
  const std::string accept =
      "--accept=pipe,name=" + pipeName() + ";urp;StarOffice.ComponentContext";
  const std::string profile =
      std::string("-env:UserInstallation=file://") + BAYMA_OFFICE_PROFILE;
  // The office exits with 81 when it must restart, as it does after creating
  // a profile; its launcher, oosplash, which needs libraries a server may not
  // have, starts it again. A shell does that here.
  const char *argv[] = {"/bin/sh",
                        "-c",
                        "while :; do \"$@\"; [ $? -eq 81 ] || exit; done",
                        "soffice",
                        binary.c_str(),
                        "--headless",
                        "--invisible",
                        "--nologo",
                        "--norestore",
                        "--nodefault",
                        "--nolockcheck",
                        accept.c_str(),
                        profile.c_str(),
                        nullptr};
  // The office renders without a display, and finds its own bootstrap files.
  std::string display = "SAL_USE_VCLPLUGIN=svp";
  std::vector<char *> env{display.data()};
  for (char **e = environ; *e; ++e)
    if (std::strncmp(*e, "SAL_USE_VCLPLUGIN=", 18) != 0 &&
        std::strncmp(*e, "URE_BOOTSTRAP=", 14) != 0)
      env.push_back(*e);
  env.push_back(nullptr);
  const std::string log = std::string(BAYMA_OFFICE_PROFILE) + ".log";
  posix_spawn_file_actions_t files;
  posix_spawn_file_actions_init(&files);
  posix_spawn_file_actions_addopen(&files, 1, log.c_str(),
                                   O_WRONLY | O_CREAT | O_APPEND, 0644);
  posix_spawn_file_actions_adddup2(&files, 1, 2);
  // In a session of its own, the office outlives the process that starts it.
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID);
  pid_t pid;
  const int spawned = posix_spawn(&pid, argv[0], &files, &attributes,
                                  const_cast<char **>(argv), env.data());
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&files);
  if (spawned != 0)
    throw std::runtime_error("could not start " + binary);
}

inline css::uno::Reference<css::uno::XComponentContext> connect() {
  if (connected.is()) {
    try {
      connected->getServiceManager();
      return connected;
    } catch (css::uno::RuntimeException const &) {
      // The office, or the connection to it, has gone.
      connected.clear();
    }
  }

  // This process's own UNO runtime reads the office's types and services.
  setenv("URE_BOOTSTRAP",
         (std::string("vnd.sun.star.pathname:") + BAYMA_OFFICE_ROOT +
          "/program/fundamentalrc")
             .c_str(),
         1);
  static auto local = cppu::defaultBootstrap_InitialComponentContext();
  auto resolver = css::bridge::UnoUrlResolver::create(local);
  const rtl::OUString url = rtl::OUString::createFromAscii(
      ("uno:pipe,name=" + pipeName() + ";urp;StarOffice.ComponentContext")
          .c_str());
  // The office takes a few seconds to start listening, and longer the first
  // time, while it creates its profile.
  for (int attempt = 0; attempt < 240; ++attempt) {
    try {
      connected.set(resolver->resolve(url), css::uno::UNO_QUERY_THROW);
      return connected;
    } catch (css::connection::NoConnectException const &) {
      if (attempt == 0)
        start();
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
  }
  throw std::runtime_error("the office did not start listening within 60 s");
}

// The office's desktop, which loads and creates documents.
inline css::uno::Reference<css::frame::XDesktop2> desktop() {
  return css::frame::Desktop::create(connect());
}

// Ends the office, and with it every document it has open.
inline void terminate() {
  desktop()->terminate();
  connected.clear();
}

} // namespace bayma_office
