#![cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]

use anyhow::Result;
use serde_json::json;

use fetchlet::{Body, FetchApp, Instance, http};

const SOURCE: &str = include_str!("fixtures/instances.js");

async fn isolation(mut a: impl Instance, mut b: impl Instance) -> Result<()> {
    assert_eq!(a.call_json("increment", &[]).await?, json!(1));
    assert_eq!(a.call_json("increment", &[]).await?, json!(2));
    assert_eq!(b.call_json("increment", &[]).await?, json!(1));
    assert_eq!(
        a.call_json("add", &[json!(20), json!(22)]).await?,
        json!(42)
    );
    assert!(a.call_json("toString", &[]).await.is_err());
    assert_eq!(
        a.call_json("add", &[json!(20), json!(22)]).await?,
        json!(42)
    );
    let mut app = FetchApp {
        instance: a,
        export: "handle".into(),
    };
    let response = app
        .handle(
            http::Request::builder()
                .uri("https://fetchlet.test/")
                .method("POST")
                .body(Body::from(vec![0, 128, 255]))?,
        )
        .await?;
    assert_eq!(response.status(), 201);
    assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
    assert_eq!(
        response.into_body().collect(1024).await?.as_ref(),
        &[0, 128, 255]
    );
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(10),
            b.call_json("never", &[])
        )
        .await
        .is_err()
    );
    assert!(
        b.call_json("add", &[json!(20), json!(22)])
            .await
            .unwrap_err()
            .to_string()
            .contains("interrupted")
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn independent_instances() -> Result<()> {
    #[cfg(feature = "quickjs")]
    isolation(
        fetchlet::QuickJs::new(SOURCE)?,
        fetchlet::QuickJs::new(SOURCE)?,
    )
    .await?;
    #[cfg(feature = "boa")]
    isolation(fetchlet::Boa::new(SOURCE)?, fetchlet::Boa::new(SOURCE)?).await?;
    #[cfg(feature = "v8")]
    isolation(fetchlet::V8::new(SOURCE)?, fetchlet::V8::new(SOURCE)?).await?;
    Ok(())
}
