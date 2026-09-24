// What a bayma C++ session with libardour starts from: libardour initialized
// with this skill's engine, instruments, and effects, and Ardour's audio
// engine running headless, on Ardour's dummy backend, which renders as fast
// as the machine can. The compile_flags.txt install.ts writes names the
// engine's folder, BAYMA_ARDOUR_ROOT.

#pragma once

#include "ardour/ardour.h"
#include "ardour/audioengine.h"
#include "ardour/session_event.h"
#include "pbd/event_loop.h"
#include "pbd/fpu.h"

#include <cstdint>
#include <cstdlib>
#include <functional>
#include <stdexcept>
#include <string>

namespace bayma_ardour {

/// Runs the callbacks Ardour queues for a thread at once, on the thread that
/// queues them, as Ardour's own headless tools do.
class ImmediateEventLoop : public sigc::trackable, public PBD::EventLoop {
public:
  ImmediateEventLoop() : PBD::EventLoop("bayma") {}

  bool call_slot(InvalidationRecord *,
                 const std::function<void()> &slot) override {
    slot();
    return true;
  }

  PBD::RWLock &slot_invalidation_rwlock() override { return lock; }

private:
  PBD::RWLock lock;
};

/// Keeps Ardour from its AVX-512 routines, which leave vector lanes
/// undefined that Clang, which built this engine, fills with whatever a
/// register held, so peaks come out NaN; it uses its AVX and FMA ones
/// instead. ARDOUR_FPU_FLAGS, Ardour's override of what it detects, takes
/// PBD::FPU's flags, whose values its header keeps private.
inline void avoidAvx512() {
  if (std::getenv("ARDOUR_FPU_FLAGS"))
    return;
  PBD::FPU *fpu = PBD::FPU::instance();
  const unsigned flags =
      (fpu->has_flush_to_zero() ? 0x1 : 0) |
      (fpu->has_denormals_are_zero() ? 0x2 : 0) | (fpu->has_sse() ? 0x4 : 0) |
      (fpu->has_sse2() ? 0x8 : 0) | (fpu->has_avx() ? 0x10 : 0) |
      (fpu->has_neon() ? 0x20 : 0) | (fpu->has_fma() ? 0x40 : 0);
  PBD::FPU::destroy();
  ::setenv("ARDOUR_FPU_FLAGS", std::to_string(flags).c_str(), 1);
}

/// Initializes libardour and starts its audio engine at `sampleRate`, for the
/// calling thread to drive sessions from. Once per process.
inline ARDOUR::AudioEngine *start(uint32_t sampleRate = 48000) {
  const std::string root = BAYMA_ARDOUR_ROOT;
  ::setenv("ARDOUR_DLL_PATH", (root + "/engine/lib/ardour9").c_str(), 1);
  ::setenv("ARDOUR_DATA_PATH", (root + "/engine/share/ardour9").c_str(), 1);
  ::setenv("ARDOUR_CONFIG_PATH", (root + "/engine/etc/ardour9").c_str(), 1);
  // The skill's plugins; Ardour finds its own beside its libraries.
  ::setenv("LV2_PATH", (root + "/lv2").c_str(), 1);
  // Its analyses, loudness among them, which exports measure with.
  ::setenv("VAMP_PATH", (root + "/engine/lib/ardour9/vamp").c_str(), 1);
  // Ardour's preferences, kept in the skill's folder.
  ::setenv("XDG_CONFIG_HOME", (root + "/config").c_str(), 1);
  avoidAvx512();
  if (!ARDOUR::init(true, (root + "/engine/share/ardour9/locale").c_str()))
    throw std::runtime_error("libardour did not initialize");
  PBD::EventLoop::set_event_loop_for_thread(new ImmediateEventLoop);
  ARDOUR::SessionEvent::create_per_thread_pool("bayma", 4096);
  ARDOUR::AudioEngine *engine = ARDOUR::AudioEngine::create();
  if (!engine->set_backend("None (Dummy)", "", ""))
    throw std::runtime_error("Ardour has no dummy backend");
  engine->set_sample_rate(sampleRate);
  if (engine->start() != 0)
    throw std::runtime_error("Ardour's audio engine did not start");
  return engine;
}

} // namespace bayma_ardour
