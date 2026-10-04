//! Mirror-node indexer for the `RecurringPayments` contract.
//!
//! Data flow: mirror node logs -> [`events`] decoder -> [`store`] (SQLite) -> [`api`] (HTTP).
//! [`sync`] drives the loop, and also follows each booked HSS schedule through to its execution result.

pub mod api;
pub mod config;
pub mod events;
pub mod mirror;
pub mod store;
pub mod sync;
