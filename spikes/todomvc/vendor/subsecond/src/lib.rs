//! Inert stand-in for dioxus's `subsecond` hot-patching runtime.
//!
//! The real crate unconditionally links js-sys/wasm-bindgen/web-sys on
//! wasm32 targets, which poisons a pure component build (wasm-bindgen's
//! describe imports survive into the module and `wasm-tools component new`
//! rejects it). In release builds dioxus-core's use of subsecond reduces to
//! "call the function directly", which is exactly what this stub does.
//!
//! API surface mirrored from subsecond 0.7.10, limited to what dioxus-core
//! 0.7.10 uses: `register_handler`, `get_jump_table`, `call`, `HotFn`
//! (`current` / `call` / `ptr_address`), `HotFnPtr`, `HotFunction`.

use std::marker::PhantomData;
use std::sync::Arc;

/// Hot-reload jump table (never present in the stub).
pub struct JumpTable;

/// Get the current jump table, if it exists. Always `None` here.
///
/// # Safety
/// Mirrors the upstream signature; the stub is trivially safe.
pub unsafe fn get_jump_table() -> Option<&'static JumpTable> {
    None
}

/// Register a hot-patch handler. The stub never patches, so this drops it.
pub fn register_handler(_handler: Arc<dyn Fn() + Send + Sync + 'static>) {}

/// Call a function under hot-patching. The stub just calls it.
pub fn call<O>(mut f: impl FnMut() -> O) -> O {
    f()
}

/// An error from a failed hot call (never produced by the stub).
#[derive(Debug)]
pub struct HotFnPanic {
    _private: (),
}

/// A pointer to a (never actually) hot-patched function.
#[non_exhaustive]
#[derive(PartialEq, Eq, Hash, Clone, Copy, Debug)]
pub struct HotFnPtr(pub u64);

/// A function whose implementation can (upstream) be hot-patched.
pub trait HotFunction<Args, Marker> {
    /// The return type of the function.
    type Return;
    /// The underlying function-pointer type.
    type Real;
    /// Call the function with the given arguments.
    fn call_it(&mut self, args: Args) -> Self::Return;
}

macro_rules! impl_hot_function {
    ($( ($marker:ident, $($arg:ident),*) ),* $(,)?) => {
        $(
            #[doc(hidden)]
            pub struct $marker;
            impl<T, R, $($arg,)*> HotFunction<($($arg,)*), $marker> for T
            where
                T: FnMut($($arg),*) -> R,
            {
                type Return = R;
                type Real = fn($($arg),*) -> R;
                #[allow(non_snake_case)]
                fn call_it(&mut self, args: ($($arg,)*)) -> Self::Return {
                    let ($($arg,)*) = args;
                    self($($arg),*)
                }
            }
        )*
    };
}

impl_hot_function!(
    (M0,),
    (M1, A1),
    (M2, A1, A2),
    (M3, A1, A2, A3),
    (M4, A1, A2, A3, A4),
    (M5, A1, A2, A3, A4, A5),
    (M6, A1, A2, A3, A4, A5, A6),
    (M7, A1, A2, A3, A4, A5, A6, A7),
    (M8, A1, A2, A3, A4, A5, A6, A7, A8),
);

/// A callable that (upstream) resolves through the hot-patch jump table.
pub struct HotFn<A, M, F>
where
    F: HotFunction<A, M>,
{
    inner: F,
    _marker: PhantomData<(A, M)>,
}

impl<A, M, F: HotFunction<A, M>> HotFn<A, M, F> {
    /// Wrap the current implementation of `f`.
    pub fn current(f: F) -> Self {
        Self {
            inner: f,
            _marker: PhantomData,
        }
    }

    /// Call the function.
    pub fn call(&mut self, args: A) -> F::Return {
        self.inner.call_it(args)
    }

    /// Attempt the call (always succeeds in the stub).
    pub fn try_call(&mut self, args: A) -> Result<F::Return, HotFnPanic> {
        Ok(self.inner.call_it(args))
    }

    /// A stable address identifying this function (upstream: possibly the
    /// patched address). Mirrors the upstream fallback logic.
    pub fn ptr_address(&self) -> HotFnPtr {
        if size_of::<F>() == size_of::<fn() -> ()>() {
            let ptr: usize = unsafe { std::mem::transmute_copy(&self.inner) };
            return HotFnPtr(ptr as u64);
        }
        let known_fn_ptr = <F as HotFunction<A, M>>::call_it as *const () as usize;
        HotFnPtr(known_fn_ptr as u64)
    }
}
