use crate::api::tasks::AppState;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use serde_json::json;
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::StreamExt;

pub async fn sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(
        Duration::from_millis(300),
    ))
    .map(move |_| {
        let tasks = state.db.list_tasks().unwrap_or_default();
        let total_speed: f64 = tasks.iter().map(|t| t.speed).sum();
        let active_count = tasks.iter().filter(|t| t.status == "downloading").count();

        let data = json!({
            "aggregate_speed": total_speed,
            "active_count": active_count,
            "tasks": tasks
        });

        Ok(Event::default().data(data.to_string()))
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
