using System.Collections.Concurrent;
using System.Text;
using Clerk.BackendAPI;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;
using MailKit.Security;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using MimeKit;
using Newtonsoft.Json.Linq;
using xedmail.Authentication;
using xedmail.Mail;
using xedmail.Model;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

// At the top of Program.cs
// Add CORS
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowNextJs", policy =>
    {
        policy.WithOrigins("http://localhost:3000")
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite("Data Source=xedmail.db"));

var app = builder.Build();

// Create database on startup
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
}

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();
app.UseCors("AllowNextJs");

var summaries = new[]
{
    "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
};

app.MapGet("/", () => "Hello world!");

ConcurrentDictionary<string, OAuthStateEntry> _stateStore = new();

app.MapGet("/oauth/start", async (HttpRequest req, ILogger<Program> logger) =>
{
    logger.LogInformation("Starting OAuth flow");
    logger.LogInformation("Request headers: {Headers}", req.Headers);
    var bearerToken = req.Headers.Authorization.ToString();
    logger.LogInformation("Bearer token: {Token}", bearerToken!);

    // Connect to Clerk SDK
    var sdk = new ClerkBackendApi(bearerAuth: bearerToken);
    var userAuth = new UserAuthentication();
    var data = await userAuth.ValidateSessionAsync(req);

    logger.LogInformation("User session data: user id {userid}, session id {sessionid}, ", data.UserId, data.SessionId);

    // Create and set in state
    var state = Path.GetRandomFileName();

    _stateStore[state] = new OAuthStateEntry()
    {
        State = state,
        ClerkUserId = data.UserId,
        Provider = "Gmail",
        Timestamp = DateTime.UtcNow
    };

    var urlParams = new Dictionary<string, string>()
    {
        ["client_id"] =
            "611007919856-g0o1ds7pf4qbh8qef9qul4ofqudp8bqk.apps.googleusercontent.com",
        ["redirect_uri"] = "http://localhost:5172/oauth/callback",
        ["response_type"] = "code",
        ["scope"] = "openid https://mail.google.com/ profile email",
        ["access_type"] = "offline",
        ["prompt"] = "consent",
        ["state"] = state,
    };

    string queryString = string.Join("&", urlParams
        .Select(kvp => $"{Uri.EscapeDataString(kvp.Key)}={Uri.EscapeDataString(kvp.Value)}"));

    var authUrl = $"https://accounts.google.com/o/oauth2/v2/auth?{queryString}";

    return Results.Ok(new { authUrl });
});

app.MapGet("/weatherforecast", () =>
    {
        var forecast = Enumerable.Range(1, 5).Select(index =>
                new WeatherForecast
                (
                    DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
                    Random.Shared.Next(-20, 55),
                    summaries[Random.Shared.Next(summaries.Length)]
                ))
            .ToArray();
        return forecast;
    })
    .WithName("GetWeatherForecast");

// app.MapGet("/oauth/callback", async (
//     HttpContext ctx, 
//     ILogger<Program> logger,
//     AppDbContext db) =>
// {
//     var code = ctx.Request.Query["code"].ToString();
//     if (string.IsNullOrEmpty(code))
//     {
//         logger.LogWarning("OAuth callback received without authorization code");
//         return Results.BadRequest("Missing code");
//     }
//     
//     using var http = new HttpClient();
//     
//     var data = new Dictionary<string, string>
//     {
//         ["code"] = code,
//         ["client_id"] = builder.Configuration["Google:ClientId"]!,
//         ["client_secret"] = builder.Configuration["Google:ClientSecret"]!,
//         ["redirect_uri"] = builder.Configuration["Google:RedirectUri"]!, 
//         ["grant_type"] = "authorization_code"
//     };
//     
//     logger.LogInformation("Exchanging authorization code for tokens");
//     
//     var tokenResponse = await http.PostAsync(
//         "https://oauth2.googleapis.com/token",
//         new FormUrlEncodedContent(data));
//     
//     if (!tokenResponse.IsSuccessStatusCode)
//     {
//         var errorContent = await tokenResponse.Content.ReadAsStringAsync();
//         logger.LogError("Token exchange failed. Status: {StatusCode}, Response: {Response}", 
//             tokenResponse.StatusCode, errorContent);
//         return Results.Problem("Failed to exchange authorization code");
//     }
//     
//     var json = await tokenResponse.Content.ReadFromJsonAsync<Dictionary<string, object>>();
//     
//     if (json == null)
//     {
//         logger.LogError("Failed to deserialize token response");
//         return Results.Problem("Invalid token response");
//     }
//     
//     // Get user info
//     var userInfoResponse = await http.GetAsync(
//         $"https://www.googleapis.com/oauth2/v3/userinfo?access_token={json["access_token"]}");
//     var userInfoJson = await userInfoResponse.Content.ReadFromJsonAsync<Dictionary<string, object>>();
//     
//     var userEmail = userInfoJson?["email"]?.ToString();
//     if (string.IsNullOrEmpty(userEmail))
//     {
//         logger.LogError("Failed to get user email");
//         return Results.Problem("Failed to get user information");
//     }
//     
//     logger.LogInformation("Successfully obtained OAuth tokens for {Email}", userEmail);
//     
//     // Calculate expiry
//     var expiresIn = int.Parse(json["expires_in"].ToString()!);
//     var expiresAt = DateTime.UtcNow.AddSeconds(expiresIn);
//     
//     // Check if user already exists
//     var existingToken = await db.UserTokens.FirstOrDefaultAsync(t => t.Email == userEmail);
//     
//     if (existingToken != null)
//     {
//         // Update existing
//         existingToken.AccessToken = json["access_token"].ToString()!;
//         existingToken.ExpiresAt = expiresAt;
//         existingToken.UpdatedAt = DateTime.UtcNow;
//         
//         if (json.ContainsKey("refresh_token"))
//         {
//             existingToken.RefreshToken = json["refresh_token"].ToString();
//         }
//         
//         logger.LogInformation("Updated existing tokens for {Email}", userEmail);
//     }
//     else
//     {
//         // Create new
//         var newToken = new UserToken
//         {
//             UserId = userEmail, // Use email as user ID for now
//             Email = userEmail,
//             AccessToken = json["access_token"].ToString()!,
//             RefreshToken = json.ContainsKey("refresh_token") ? json["refresh_token"].ToString() : null,
//             ExpiresAt = expiresAt
//         };
//         
//         db.UserTokens.Add(newToken);
//         logger.LogInformation("Created new token record for {Email}", userEmail);
//     }
//     
//     await db.SaveChangesAsync();
//     
//     // Redirect back to Next.js with user email
//     var nextJsUrl = builder.Configuration["NextJs:BaseUrl"];
//     return Results.Redirect($"{nextJsUrl}/auth/callback?email={Uri.EscapeDataString(userEmail)}");
// });

app.MapGet("/oauth/callback", async (HttpRequest req, ILogger<Program> logger, AppDbContext db) =>
{
    // 1) Validate 'state' stored in session or DB (CSRF)
    // 2) Validate Clerk session from Authorization header / cookie -> get clerkUserId
    var userAuth = new UserAuthentication();
    // var data = await userAuth.ValidateSessionAsync(req);
    // var clerkUserId = data.UserId; 

    var q = req.Query;
    string state = q["state"];
    string code = q["code"];
    if (string.IsNullOrEmpty(state) || string.IsNullOrEmpty(code))
        return Results.BadRequest("Missing state or code");

    if (!_stateStore.TryRemove(state, out var entry))
        return Results.BadRequest("Invalid or expired state");

    // optional: check entry.CreatedAt not too old

    string clerkUserId = entry.ClerkUserId;
    string provider = entry.Provider;

    // 3) Exchange code for tokens with provider
    if (string.IsNullOrEmpty(code))
    {
        logger.LogWarning("OAuth callback received without authorization code");
        return Results.BadRequest("Missing code");
    }

    using var http = new HttpClient();

    var postData = new Dictionary<string, string>
    {
        ["code"] = code,
        ["client_id"] = builder.Configuration["Google:ClientId"]!,
        ["client_secret"] = builder.Configuration["Google:ClientSecret"]!,
        ["redirect_uri"] = builder.Configuration["Google:RedirectUri"]!,
        ["grant_type"] = "authorization_code"
    };

    logger.LogInformation("Exchanging authorization code for tokens");

    var json = await http.PostAsync(
        "https://oauth2.googleapis.com/token",
        new FormUrlEncodedContent(postData));

    if (!json.IsSuccessStatusCode)
    {
        var errorContent = await json.Content.ReadAsStringAsync();
        logger.LogError("Token exchange failed. Status: {StatusCode}, Response: {Response}",
            json.StatusCode, errorContent);
        return Results.Problem("Failed to exchange authorization code");
    }

    var tokenResponse = await json.Content.ReadFromJsonAsync<Dictionary<string, object>>();

    if (tokenResponse == null)
    {
        logger.LogError("Failed to deserialize token response");
        return Results.Problem("Invalid token response");
    }

    // 4) Get the user's email from token / userinfo endpoint if possible
    // Get user info
    var userInfoResponse = await http.GetAsync(
        $"https://www.googleapis.com/oauth2/v3/userinfo?access_token={tokenResponse["access_token"]}");
    var userInfoJson = await userInfoResponse.Content.ReadFromJsonAsync<Dictionary<string, object>>();

    var email = userInfoJson?["email"]?.ToString();
    if (string.IsNullOrEmpty(email))
    {
        logger.LogError("Failed to get user email");
        return Results.Problem("Failed to get user information");
    }

    logger.LogInformation("Successfully obtained OAuth tokens for {Email}", email);

    // Calculate expiry
    var expiresIn = int.Parse(tokenResponse["expires_in"].ToString()!);
    var expiresAt = DateTime.UtcNow.AddSeconds(expiresIn);
    logger.LogInformation("Token expiry: {ExpiresAt}", expiresAt);

    // 5) Create or update UserProfile / Mailbox
    // Check if user already exists
// Check if user already exists
    var profile = await db.UserProfiles
        .Include(p => p.Mailboxes) // IMPORTANT: Load mailboxes
        .FirstOrDefaultAsync(p => p.ClerkUserId == clerkUserId);

    bool isNewProfile = false;
    if (profile == null)
    {
        profile = new UserProfile { ClerkUserId = clerkUserId };
        db.UserProfiles.Add(profile); // Use Add() for new entities
        isNewProfile = true;
    }

    var mailbox = profile.Mailboxes.FirstOrDefault(m => m.EmailAddress == email && m.Provider == provider);

    bool isNewMailbox = false;
    if (mailbox == null)
    {
        mailbox = new Mailbox
        {
            Id = Guid.NewGuid(),
            Provider = provider,
            EmailAddress = email,
            Image = userInfoJson?["picture"].ToString()
        };
        profile.Mailboxes.Add(mailbox);
        isNewMailbox = true;
    }

    mailbox.EncryptedAccessToken = tokenResponse["access_token"].ToString();
    mailbox.EncryptedRefreshToken = tokenResponse["refresh_token"]?.ToString();
    mailbox.AccessTokenExpiresAt = expiresAt;
    mailbox.Scopes = string.Join(" ", tokenResponse["scope"] ?? Enumerable.Empty<string>());
    mailbox.LastSyncAt = null;
    await db.SaveChangesAsync();

    // 6) Redirect to the frontend success page
    var nextJsUrl = builder.Configuration["NextJs:BaseUrl"];
    // res.Redirect($"{nextJsUrl}/auth/callback?email={Uri.EscapeDataString(email)}");

    return Results.Redirect($"{nextJsUrl}");
});

// API endpoint to get tokens
app.MapGet("/api/tokens", (HttpContext ctx) =>
{
    var accessToken = ctx.Session.GetString("google_access_token");

    if (string.IsNullOrEmpty(accessToken))
        return Results.Unauthorized();

    return Results.Ok(new
    {
        access_token = accessToken,
        refresh_token = ctx.Session.GetString("google_refresh_token")
    });
});

// API endpoint to get all emails from the inbox
app.MapGet("/api/inbox/all", async (
    HttpContext ctx,
    ILogger<Program> logger,
    AppDbContext db,
    string email
) =>
{
    logger.LogInformation("Connecting {Email}'s inbox", email);
    if (string.IsNullOrEmpty(email))
    {
        logger.LogWarning("No email provided");
        return Results.BadRequest("Email required");
    }

    var userToken = await db.UserTokens.FirstOrDefaultAsync(t => t.Email == email);

    if (userToken == null)
    {
        logger.LogWarning("No token found for {Email}", email);
        return Results.NotFound("User not authenticated with Google");
    }

    // Check if token is expired
    if (userToken.ExpiresAt <= DateTime.UtcNow)
    {
        logger.LogWarning("Access token expired for {Email}", email);

        using var http = new HttpClient();

        var data = new Dictionary<string, string>
        {
            ["refresh_token"] = userToken.RefreshToken!,
            ["client_id"] = builder.Configuration["Google:ClientId"]!,
            ["client_secret"] = builder.Configuration["Google:ClientSecret"]!,
            ["grant_type"] = "refresh_token"
        };

        var accessTokenData =
            await http.PostAsync("https://oauth2.googleapis.com/token", new FormUrlEncodedContent(data));
        var refreshedAccessToken = await accessTokenData.Content.ReadFromJsonAsync<Dictionary<string, object>>();

        if (refreshedAccessToken == null)
            return Results.Problem("Failed to refresh access token");

        logger.LogInformation("Refreshed access token for {Email}, {refreshedAccessToken}", email,
            refreshedAccessToken);
        userToken.AccessToken = refreshedAccessToken["access_token"].ToString()!;
        userToken.ExpiresAt = DateTime.UtcNow.AddSeconds(int.Parse(refreshedAccessToken["expires_in"].ToString()!));
        userToken.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        return Results.Problem("Access token expired. Please re-authenticate.");
    }

    logger.LogInformation("Fetching inbox for {Email}", email);

    MailClient mailClient = new();
    await mailClient.Connect(userToken.Email, userToken.AccessToken);
    var messages = await mailClient.GetInbox();

    logger.LogInformation("Got {Count} messages for {Email}", messages.Count, email);

    var emailDtos = messages.Select(m => new EmailDto
    {
        Id = m.MessageId ?? Guid.NewGuid().ToString(),
        Subject = m.Subject ?? "(No Subject)",
        From = m.From.Mailboxes.FirstOrDefault()?.Address ?? "unknown",
        To = string.Join(", ", m.To.Mailboxes.Select(mb => mb.Address)),
        Body = m.HtmlBody ?? m.TextBody ?? "(No Content)",
        Date = m.Date.UtcDateTime,
        IsRead = false // You'll need to get this from IMAP flags if available
    }).ToList();

    return Results.Ok(emailDtos);
});

app.MapGet("/search", async (HttpContext ctx, ILogger<Program> logger, AppDbContext db, [FromQuery] string query) =>
{
    var startTime = DateTime.UtcNow;
    // Verify user request and get their unique id
    logger.LogInformation("Searching for {Query}", query);
    var request = ctx.Request;
    var userAuth = new UserAuthentication();
    var clerkValidationInfo = await userAuth.ValidateSessionAsync(request);

    if (!clerkValidationInfo.IsSignedIn)
    {
        return Results.Unauthorized();
    }

    var userClerkId = clerkValidationInfo.UserId;

    // Create and hold a reference to the HTTP client
    using var http = new HttpClient();

    // Retrieve all inboxes for the user
    var userProfile = await db.UserProfiles
        .Include(p => p.Mailboxes)
        .FirstOrDefaultAsync(p => p.ClerkUserId == userClerkId);

    if (userProfile == null)
    {
        return Results.NotFound($"User profile not found for id {userClerkId}");
    }

    var inboxes = userProfile.Mailboxes;

    // Check if the tokens are expired. If so, refresh them
    if (userProfile.Mailboxes.Any(m => m.AccessTokenExpiresAt < DateTime.UtcNow))
    {
        logger.LogWarning("Access token expired for one or more of {ClerkId}'s inboxes", userClerkId);

        var mailboxesWithExpiredTokens =
            userProfile.Mailboxes.Where(m => m.AccessTokenExpiresAt < DateTime.UtcNow).ToList();

        foreach (var mailbox in mailboxesWithExpiredTokens)
        {
            var data = new Dictionary<string, string>
            {
                ["refresh_token"] = mailbox.EncryptedRefreshToken!,
                ["client_id"] = builder.Configuration["Google:ClientId"]!,
                ["client_secret"] = builder.Configuration["Google:ClientSecret"]!,
                ["grant_type"] = "refresh_token"
            };

            var accessTokenData = await http.PostAsync("https://oauth2.googleapis.com/token",
                new FormUrlEncodedContent(data));
            var refreshedAccessToken =
                await accessTokenData.Content.ReadFromJsonAsync<Dictionary<string, object>>();

            if (refreshedAccessToken == null)
                return Results.Problem("Failed to refresh access token");

            logger.LogInformation("Refreshed access token for {DisplayName}, {refreshedAccessToken}",
                mailbox.UserProfile.DisplayName,
                refreshedAccessToken);
            mailbox.EncryptedAccessToken = refreshedAccessToken["access_token"].ToString()!;
            mailbox.AccessTokenExpiresAt =
                DateTime.UtcNow.AddSeconds(int.Parse(refreshedAccessToken["expires_in"].ToString()!));
            await db.SaveChangesAsync();
        }
    }

    // Fetch the emails for each inbox
    // Database
    logger.LogInformation("Fetching emails for {ClerkId}'s inboxes", userClerkId);
    var mailboxes = userProfile.Mailboxes.ToList();

    var emails = new List<EmailDto>();

    logger.LogInformation("Looping over all inboxes to fetch emails up:{UserProfile}, mbs {Mailboxes}.",
        userProfile.ClerkUserId, mailboxes.Count);
    foreach (var mailbox in mailboxes)
    {
        //OAuth
        Console.WriteLine("Connecting to Gmail IMAP server");

        var oauth2 = new SaslMechanismOAuthBearer(mailbox.EmailAddress, mailbox.EncryptedAccessToken);

        using var client = new ImapClient();

        await client.ConnectAsync("imap.gmail.com", 993, SecureSocketOptions.SslOnConnect);
        await client.AuthenticateAsync(oauth2);

        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadOnly);

        logger.LogInformation("Connected to Gmail IMAP server");
        logger.LogInformation("Parsing search query");

        var results = await http.PostAsJsonAsync("http://127.0.0.1:8000/parse", new { query });
        var json = await results.Content.ReadAsStringAsync();

        logger.LogInformation("Parsed search query & Got search results: {Results}", json);

        var parsed = JObject.Parse(json);
        var filters = parsed["filters"];

        SearchQuery search = SearchQuery.All;

        // Apply status filter
        if (filters?["status"]?.ToString() == "unread")
            search.And(SearchQuery.NotSeen);
        else if (filters?["status"]?.ToString() == "read")
            search.And(SearchQuery.Seen);

        // Apply date filter
        var today = DateTime.UtcNow.Date;
        if (filters?["date"]?.ToString() == "today")
            search = search.And(SearchQuery.DeliveredOn(today));
        else if (filters?["date"]?.ToString() == "yesterday")
            search = search.And(SearchQuery.DeliveredOn(today.AddDays(-1)));

        // Apply sender filter
        if (filters?["from"] != null)
        {
            var sender = filters["from"]!.ToString();
            search = search.And(SearchQuery.FromContains(sender));
        }

        var searchResults = await inbox.SearchAsync(search);
        var twentySearchResults = searchResults.ToList();
        var messageSummaries = await inbox.FetchAsync(
            twentySearchResults,
            MessageSummaryItems.Envelope |
            MessageSummaryItems.GMailMessageId |
            MessageSummaryItems.UniqueId |
            MessageSummaryItems.Flags |
            MessageSummaryItems.BodyStructure
        );
        var messagesSummariesInfoList = messageSummaries.Reverse().ToList();
        // var trimmedSearchResults = searchResults.TakeLast(20).Reverse();
        // var messages = trimmedSearchResults.Select(x => inbox.GetMessage(x)).ToList();

        logger.LogInformation("Got {Count} messages", messageSummaries.Count);

        // We already have messageSummaries and messagesSummariesInfoList (both reversed)
        var summariesList = messageSummaries.Reverse().ToList();
        var infoList = messagesSummariesInfoList; // Already reversed above

        var emailsForMailbox = new List<EmailDto>();

        foreach (var (m, index) in summariesList.Select((m, i) => (m, i)))
        {
            var info = index < infoList.Count ? infoList[index] : null;
            // string? bodyPreview = null;
            //
            // var textPart = m.TextBody ?? m.HtmlBody;
            // if (textPart != null)
            // {
            //     try
            //     {
            //         // Fetch one at a time to avoid concurrency
            //         var bodyPart = await inbox.GetBodyPartAsync(m.UniqueId, textPart);
            //
            //         if (bodyPart is TextPart textPartContent)
            //         {
            //             var text = textPartContent.Text;
            //             bodyPreview = text.Length > 500 ? text[..500] + "..." : text;
            //         }
            //     }
            //     catch (Exception ex)
            //     {
            //         logger.LogWarning(ex, "Failed to fetch body preview for message {Id}", m.GMailMessageId);
            //     }
            // }

            emailsForMailbox.Add(new EmailDto
            {
                Id = m.GMailMessageId?.ToString() ?? Guid.NewGuid().ToString(),
                Uid = info?.UniqueId.Id.ToString() ?? Guid.NewGuid().ToString(),
                Subject = m.NormalizedSubject ?? "(No Subject)",
                From = m.Envelope?.From?.Mailboxes?.FirstOrDefault()?.Address ?? "unknown",
                To = m.Envelope?.To != null
                    ? string.Join(", ", m.Envelope.To.Mailboxes.Select(mb => mb.Address))
                    : "unknown",
                // Body = bodyPreview ?? "(No Content)",
                Date = m.Date != default ? m.Date.UtcDateTime : DateTime.UtcNow,
                IsRead = info?.Flags?.HasFlag(MessageFlags.Seen) ?? false
            });
        }

        emails.AddRange(emailsForMailbox);

        await client.DisconnectAsync(true);
    }

    var endTime = DateTime.UtcNow;

    logger.LogInformation("Fetched emails for {ClerkId}'s inboxes in {ElapsedMinutes}m and {ElapsedSeconds}s",
        userClerkId, (endTime - startTime).TotalMinutes, (endTime - startTime).TotalSeconds);

    return Results.Ok(emails);
});

app.MapGet("/emails/{emailId}",
    async (HttpContext ctx, ILogger<Program> logger, AppDbContext db, string emailId, [FromQuery(Name = "query")] string emailAddress) =>
    {
        logger.LogInformation("Connecting {Email}'s inbox", emailAddress);
        // Get an email's body 
        
        // Verify user request and get their unique id
        var request = ctx.Request;
        var userAuth = new UserAuthentication();
        var clerkValidationInfo = await userAuth.ValidateSessionAsync(request);
        
        logger.LogInformation("1 {IsSignedIn} {UserId}", clerkValidationInfo.IsSignedIn, clerkValidationInfo.UserId);

        if (!clerkValidationInfo.IsSignedIn)
        {
            return Results.Unauthorized();
        }
        
        logger.LogInformation("2");
        
        var userClerkId = clerkValidationInfo.UserId;
        
        // Create and hold a reference to the HTTP client
        using var http = new HttpClient();
        
        // Retrieve all inboxes for the user
        var userProfile = await db.UserProfiles
            .Include(p => p.Mailboxes)
            .FirstOrDefaultAsync(p => p.ClerkUserId == userClerkId);
        
        if (userProfile == null)
        {
            return Results.NotFound($"User profile not found for id {userClerkId}");
        }
        
        var mailbox = userProfile.Mailboxes.Find(m => m.EmailAddress == emailAddress);
        
        if (mailbox == null)
        {
            return Results.NotFound($"Inbox not found for email address {emailAddress}");
        }
        
        // Check if the tokens are expired. If so, refresh them
        if (mailbox.AccessTokenExpiresAt < DateTime.UtcNow)
        {
            logger.LogWarning("Access token expired for mailbox");
        
            var data = new Dictionary<string, string>
            {
                ["refresh_token"] = mailbox.EncryptedRefreshToken!,
                ["client_id"] = builder.Configuration["Google:ClientId"]!,
                ["client_secret"] = builder.Configuration["Google:ClientSecret"]!,
                ["grant_type"] = "refresh_token"
            };
        
            var accessTokenData = await http.PostAsync("https://oauth2.googleapis.com/token",
                new FormUrlEncodedContent(data));
            var refreshedAccessToken =
                await accessTokenData.Content.ReadFromJsonAsync<Dictionary<string, object>>();
        
            if (refreshedAccessToken == null)
                return Results.Problem("Failed to refresh access token");
        
            logger.LogInformation("Refreshed access token for {DisplayName}, {refreshedAccessToken}",
                mailbox.UserProfile.DisplayName,
                refreshedAccessToken);
            mailbox.EncryptedAccessToken = refreshedAccessToken["access_token"].ToString()!;
            mailbox.AccessTokenExpiresAt =
                DateTime.UtcNow.AddSeconds(int.Parse(refreshedAccessToken["expires_in"].ToString()!));
            await db.SaveChangesAsync();
        }
        
        // Fetch the emails for each inbox
        // Database
        logger.LogInformation("Fetching emails from {EmailAddress} inbox", emailAddress);
        
        //OAuth
        Console.WriteLine("Connecting to Gmail IMAP server");
        
        var oauth2 = new SaslMechanismOAuthBearer(mailbox.EmailAddress, mailbox.EncryptedAccessToken);
        
        using var client = new ImapClient();
        
        await client.ConnectAsync("imap.gmail.com", 993, SecureSocketOptions.SslOnConnect);
        await client.AuthenticateAsync(oauth2);
        
        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadOnly);
        
        logger.LogInformation("Connected to Gmail IMAP server");
        
        var message = inbox.GetMessage(UniqueId.Parse(emailId));
        var searchResult = await inbox.SearchAsync(SearchQuery.HeaderContains("Message-ID", message.MessageId));
        logger.LogInformation("Got search result: {SearchResult}", searchResult);
        var messageSummary = await inbox.FetchAsync(
            searchResult,
            MessageSummaryItems.Envelope |
            MessageSummaryItems.GMailMessageId |
            MessageSummaryItems.UniqueId |
            MessageSummaryItems.Flags |
            MessageSummaryItems.BodyStructure
        );
        logger.LogInformation("Got {Count} messages", messageSummary.Count);
        var messageSummaryInfo = messageSummary.FirstOrDefault();
            
        var email = new EmailDto
        {
            Id = messageSummaryInfo?.GMailMessageId.ToString() ?? Guid.NewGuid().ToString(),
            Uid = messageSummaryInfo?.UniqueId.Id.ToString() ?? Guid.NewGuid().ToString(),
            Subject = message.Subject ?? "(No Subject)",
            From = messageSummaryInfo?.Envelope?.From?.Mailboxes?.FirstOrDefault()?.Address ?? "unknown",
            To = messageSummaryInfo?.Envelope?.To != null
                ? string.Join(", ", messageSummaryInfo.Envelope.To.Mailboxes.Select(mb => mb.Address))
                : "unknown",
            Body = message.HtmlBody ?? message.TextBody ?? "(No Content)",
            Date = messageSummaryInfo != null && messageSummaryInfo.Date != default ? messageSummaryInfo.Date.UtcDateTime : DateTime.UtcNow,
            IsRead = messageSummaryInfo?.Flags?.HasFlag(MessageFlags.Seen) ?? false
        };
        
        logger.LogInformation("Got email: {Email}", email.Subject);
        
        await client.DisconnectAsync(true);
        
        return Results.Ok(email);
    });

app.MapPatch("/api/emails/{uid}",
    async (HttpContext ctx, ILogger<Program> logger, AppDbContext db, string uid, string email, bool isRead) =>
    {
        logger.LogInformation("Email {Uid} Read status is {IsRead} for {email}", uid, isRead, email);

        // Database
        var userToken = await db.UserTokens.FirstOrDefaultAsync(t => t.Email == email);

        using var http = new HttpClient();

        if (userToken == null)
        {
            logger.LogWarning("No token found for {Email}", email);
            return Results.NotFound("User not authenticated with Google");
        }

        // Check if token is expired
        if (userToken.ExpiresAt <= DateTime.UtcNow)
        {
            logger.LogWarning("Access token expired for {Email}", email);

            var data = new Dictionary<string, string>
            {
                ["refresh_token"] = userToken.RefreshToken!,
                ["client_id"] = builder.Configuration["Google:ClientId"]!,
                ["client_secret"] = builder.Configuration["Google:ClientSecret"]!,
                ["grant_type"] = "refresh_token"
            };

            var accessTokenData =
                await http.PostAsync("https://oauth2.googleapis.com/token", new FormUrlEncodedContent(data));
            var refreshedAccessToken = await accessTokenData.Content.ReadFromJsonAsync<Dictionary<string, object>>();

            if (refreshedAccessToken == null)
                return Results.Problem("Failed to refresh access token");

            logger.LogInformation("Refreshed access token for {Email}, {refreshedAccessToken}", email,
                refreshedAccessToken);
            userToken.AccessToken = refreshedAccessToken["access_token"].ToString()!;
            userToken.ExpiresAt = DateTime.UtcNow.AddSeconds(int.Parse(refreshedAccessToken["expires_in"].ToString()!));
            userToken.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();

            return Results.Problem("Access token expired. Please re-authenticate.");
        }

        using var client = new ImapClient();
        await client.ConnectAsync("imap.gmail.com", 993, SecureSocketOptions.SslOnConnect);
        var oauth2 = new SaslMechanismOAuthBearer(email, userToken.AccessToken);
        await client.AuthenticateAsync(oauth2);

        var inbox = client.Inbox;
        inbox.Open(FolderAccess.ReadWrite);

        var emailUid = MailKit.UniqueId.Parse(uid);
        var message = await inbox.GetMessageAsync(emailUid);

        if (message == null) return Results.Problem("Message not found");

        if (!isRead)
            await inbox.AddFlagsAsync(emailUid, MessageFlags.Seen, true);
        else
            await inbox.RemoveFlagsAsync(emailUid, MessageFlags.Seen, true);
        logger.LogInformation("Marking email {Uid} as {IsRead} for {email}", uid, !isRead, email);

        await client.DisconnectAsync(true);

        return Results.NoContent();
    });


// Mailboxes

app.MapGet("/mailboxes", async (HttpContext ctx, ILogger<Program> logger, AppDbContext db) =>
{
    // Get all mailboxes for the user
    
    logger.LogInformation("Getting mailboxes");
    // Verify user request and get their unique id
    var userAuth = new UserAuthentication();
    var clerkValidationInfo = await userAuth.ValidateSessionAsync(ctx.Request);

    if (!clerkValidationInfo.IsSignedIn)
    {
        return Results.Unauthorized();
    }
    
    // Get all mailboxes for the user from the database
    var userProfile = await db.UserProfiles.Include(p => p.Mailboxes).FirstOrDefaultAsync(p => p.ClerkUserId == clerkValidationInfo.UserId);


    var mailboxes = userProfile?.Mailboxes.Select(m => new MailboxDto
        { Id = m.Id.ToString(), EmailAddress = m.EmailAddress, Image = m.Image }
    );
    
    return userProfile == null ? Results.NotFound($"No mailboxes found for userProfile {clerkValidationInfo.UserId}") : Results.Ok(mailboxes);
});

app.Run();

record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}

public partial record OAuthStateEntry
{
    public string State { get; set; }
    public string ClerkUserId { get; set; }
    public string Provider { get; set; }
    public DateTime Timestamp { get; set; }
}

public class MailboxDto
{
    public string Id { get; set; }
    public string EmailAddress { get; set; }
    public string Image { get; set; }
    
}

// Add this class to your Program.cs
public class EmailDto
{
    public string Id { get; set; } = string.Empty;
    public string Uid { get; set; } = string.Empty;
    public string Subject { get; set; } = string.Empty;
    public string From { get; set; } = string.Empty;
    public string? To { get; set; }
    public string? Body { get; set; }
    public DateTime Date { get; set; }
    public bool IsRead { get; set; }
}