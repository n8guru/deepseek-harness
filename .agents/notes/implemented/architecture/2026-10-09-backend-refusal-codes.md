# Agent Note: Typed backend refusals

Status: implemented

English | [中文](2026-10-09-backend-refusal-codes.zh.md)

## Problem

Maintenance consumers need to identify unsupported adapters without parsing diagnostic prose or assuming a deployment inventory is complete.

## Decision

`LlmRuntime.backendCoverage()` emits a provider-independent typed refusal on each non-settled participant, alongside its diagnostic reason and exact provider registrations. Every actual or retained adapter instance participates. The aggregate verdict depends on refusal codes, not diagnostic text.

## Alternatives considered

A provider allowlist would silently omit new or withdrawn registrations. Inferring settlement from an idle agent or a stopped caller would confuse frontend quiescence with backend completion. Neither is accepted.

## Consequences

An adapter without authoritative backendStatus evidence prevents drain, even if never used. A supported-subset test proves only that subset; an assembled full-profile test must retain and name unsupported adapters. An inventory is evidence, not permission to skip a participant. Unit tests cover new and withdrawn unsupported routes; the built-profile test checks the named refusal over authenticated HTTP.
