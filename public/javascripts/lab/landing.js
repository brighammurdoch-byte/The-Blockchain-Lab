/**
 * Blockchain Lab Landing Page
 * Handle session creation and joining
 */

$(document).ready(function() {
  // Create Session
  $('#createSessionBtn').click(function() {
    $.post('/lab/create', function(data) {
      if (data.success) {
        // Display admin token
        $('#adminToken').text(data.adminToken);
        $('#adminTokenDisplay').show();
        
        // Store adminToken and joinCode in localStorage
        localStorage.setItem('adminToken_' + data.sessionId, data.adminToken);
        localStorage.setItem('joinCode_' + data.sessionId, data.joinCode);
        
        // Redirect to admin after 2 seconds
        setTimeout(function() {
          window.location.href = '/lab/admin/' + data.sessionId;
        }, 2000);
      } else {
        alert('Error creating session: ' + data.error);
      }
    }).fail(function(error) {
      alert('Failed to create session');
    });
  });

  // Join Session
  $('#joinForm').submit(function(e) {
    e.preventDefault();
    
    const joinCode = $('#joinCode').val().trim().toUpperCase();
    const rawRole = $('#roleSelect').val();
    
    // Map legacy HTML values to new roles
    let role = rawRole;
    if (rawRole === 'observer') role = 'wallet';
    if (rawRole === 'participant') role = 'miner';
    
    $.ajax({
      type: 'POST',
      url: '/lab/join',
      contentType: 'application/json',
      data: JSON.stringify({
        joinCode: joinCode,
        role: role
      }),
      success: function(data) {
        if (data.success) {
          // Store joinCode and userId in localStorage
          localStorage.setItem('joinCode_' + data.sessionId, joinCode);
          localStorage.setItem('userId_' + data.sessionId, data.userId);
          
          if (role === 'wallet') {
            window.location.href = '/lab/observe/' + data.sessionId;
          } else {
            window.location.href = '/lab/participate/' + data.sessionId;
          }
        } else {
          alert('Error joining session: ' + data.error);
        }
      },
      error: function(xhr) {
        if (xhr.responseJSON && xhr.responseJSON.error) {
          alert('Error joining session: ' + xhr.responseJSON.error);
        } else {
          alert('Failed to join session. Check your code and try again.');
        }
      }
    });
  });

  // Update role select hint text
  $('#roleSelect').change(function() {
    const role = $(this).val();
    const $joinBtn = $('#joinForm button[type="submit"]');
    if (role === 'observer' || role === 'wallet') {
      $joinBtn.text('Join as Wallet');
    } else {
      $joinBtn.text('Join as Miner');
    }
  });
});
