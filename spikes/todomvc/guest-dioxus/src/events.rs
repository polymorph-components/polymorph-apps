//! Event-record → dioxus event-data conversion. The surface delivers plain
//! records; this module is the custom-renderer half of dioxus-html's event
//! system: a `PlatformEventData` payload plus an `HtmlEventConverter` that
//! builds the typed event data dioxus handlers see.

use std::any::Any;

use dioxus_html::geometry::{
    ClientPoint, Coordinates, ElementPoint, PagePoint, ScreenPoint,
};
use dioxus_html::input_data::{MouseButton, MouseButtonSet};
use dioxus_html::keyboard_types::{Code, Key, Location, Modifiers};
use dioxus_html::{
    AnimationData, CancelData, ClipboardData, CompositionData, DragData, FocusData, FormData,
    FormValue, HasFileData, HasFocusData, HasFormData, HasKeyboardData, HasMouseData,
    HtmlEventConverter, ImageData, InteractionElementOffset, InteractionLocation, KeyboardData,
    MediaData, ModifiersInteraction, MountedData, MouseData, PlatformEventData, PointerData,
    PointerInteraction, ResizeData, ScrollData, SelectionData, ToggleData, TouchData,
    TransitionData, VisibleData, WheelData,
};

/// What crosses from the WIT event record into dioxus.
#[derive(Debug, Clone)]
pub struct Payload {
    pub key: Option<String>,
    pub value: Option<String>,
    pub checked: Option<bool>,
}

fn payload(event: &PlatformEventData) -> Payload {
    event
        .downcast::<Payload>()
        .cloned()
        .expect("event payload must be a surface Payload")
}

// --- form ---------------------------------------------------------------------

#[derive(Debug)]
struct SurfaceFormData(Payload);

impl HasFileData for SurfaceFormData {
    fn files(&self) -> Vec<dioxus_html::FileData> {
        Vec::new()
    }
}

impl HasFormData for SurfaceFormData {
    fn value(&self) -> String {
        // Checkbox convention (matches dioxus-web): checked as "true"/"false",
        // which FormData::checked() parses back out.
        match self.0.checked {
            Some(b) => b.to_string(),
            None => self.0.value.clone().unwrap_or_default(),
        }
    }

    fn valid(&self) -> bool {
        true
    }

    fn values(&self) -> Vec<(String, FormValue)> {
        Vec::new()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// --- keyboard ------------------------------------------------------------------

#[derive(Debug)]
struct SurfaceKeyboardData(Payload);

impl ModifiersInteraction for SurfaceKeyboardData {
    fn modifiers(&self) -> Modifiers {
        Modifiers::empty()
    }
}

impl HasKeyboardData for SurfaceKeyboardData {
    fn key(&self) -> Key {
        let raw = self.0.key.as_deref().unwrap_or("Unidentified");
        raw.parse::<Key>()
            .unwrap_or_else(|_| Key::Character(raw.to_string()))
    }

    fn code(&self) -> Code {
        Code::Unidentified
    }

    fn location(&self) -> Location {
        Location::Standard
    }

    fn is_auto_repeating(&self) -> bool {
        false
    }

    fn is_composing(&self) -> bool {
        false
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// --- mouse ---------------------------------------------------------------------

#[derive(Debug)]
struct SurfaceMouseData;

impl InteractionLocation for SurfaceMouseData {
    fn client_coordinates(&self) -> ClientPoint {
        ClientPoint::zero()
    }

    fn screen_coordinates(&self) -> ScreenPoint {
        ScreenPoint::zero()
    }

    fn page_coordinates(&self) -> PagePoint {
        PagePoint::zero()
    }
}

impl InteractionElementOffset for SurfaceMouseData {
    fn element_coordinates(&self) -> ElementPoint {
        ElementPoint::zero()
    }

    fn coordinates(&self) -> Coordinates {
        Coordinates::new(
            ScreenPoint::zero(),
            ClientPoint::zero(),
            ElementPoint::zero(),
            PagePoint::zero(),
        )
    }
}

impl ModifiersInteraction for SurfaceMouseData {
    fn modifiers(&self) -> Modifiers {
        Modifiers::empty()
    }
}

impl PointerInteraction for SurfaceMouseData {
    fn trigger_button(&self) -> Option<MouseButton> {
        Some(MouseButton::Primary)
    }

    fn held_buttons(&self) -> MouseButtonSet {
        MouseButtonSet::empty()
    }
}

impl HasMouseData for SurfaceMouseData {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// --- focus ---------------------------------------------------------------------

#[derive(Debug)]
struct SurfaceFocusData;

impl HasFocusData for SurfaceFocusData {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// --- the converter ---------------------------------------------------------------

pub struct Converter;

fn unsupported(family: &str) -> ! {
    panic!("event family '{family}' is not in the surface vocabulary")
}

impl HtmlEventConverter for Converter {
    fn convert_animation_data(&self, _: &PlatformEventData) -> AnimationData {
        unsupported("animation")
    }
    fn convert_cancel_data(&self, _: &PlatformEventData) -> CancelData {
        unsupported("cancel")
    }
    fn convert_clipboard_data(&self, _: &PlatformEventData) -> ClipboardData {
        unsupported("clipboard")
    }
    fn convert_composition_data(&self, _: &PlatformEventData) -> CompositionData {
        unsupported("composition")
    }
    fn convert_drag_data(&self, _: &PlatformEventData) -> DragData {
        unsupported("drag")
    }
    fn convert_focus_data(&self, _: &PlatformEventData) -> FocusData {
        FocusData::new(SurfaceFocusData)
    }
    fn convert_form_data(&self, event: &PlatformEventData) -> FormData {
        FormData::new(SurfaceFormData(payload(event)))
    }
    fn convert_image_data(&self, _: &PlatformEventData) -> ImageData {
        unsupported("image")
    }
    fn convert_keyboard_data(&self, event: &PlatformEventData) -> KeyboardData {
        KeyboardData::new(SurfaceKeyboardData(payload(event)))
    }
    fn convert_media_data(&self, _: &PlatformEventData) -> MediaData {
        unsupported("media")
    }
    fn convert_mounted_data(&self, _: &PlatformEventData) -> MountedData {
        unsupported("mounted")
    }
    fn convert_mouse_data(&self, _: &PlatformEventData) -> MouseData {
        MouseData::new(SurfaceMouseData)
    }
    fn convert_pointer_data(&self, _: &PlatformEventData) -> PointerData {
        unsupported("pointer")
    }
    fn convert_scroll_data(&self, _: &PlatformEventData) -> ScrollData {
        unsupported("scroll")
    }
    fn convert_selection_data(&self, _: &PlatformEventData) -> SelectionData {
        unsupported("selection")
    }
    fn convert_toggle_data(&self, _: &PlatformEventData) -> ToggleData {
        unsupported("toggle")
    }
    fn convert_touch_data(&self, _: &PlatformEventData) -> TouchData {
        unsupported("touch")
    }
    fn convert_transition_data(&self, _: &PlatformEventData) -> TransitionData {
        unsupported("transition")
    }
    fn convert_wheel_data(&self, _: &PlatformEventData) -> WheelData {
        unsupported("wheel")
    }
    fn convert_resize_data(&self, _: &PlatformEventData) -> ResizeData {
        unsupported("resize")
    }
    fn convert_visible_data(&self, _: &PlatformEventData) -> VisibleData {
        unsupported("visible")
    }
}
